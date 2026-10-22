"""Workflow B's real SQL + real JS, chained exactly as the n8n nodes chain them, on the sample file.

The optimised pipeline (SQL classes → bitset matcher → set-based expansion) must produce exactly
the pairs the brute-force oracle produces.
"""

import importlib.util
import json
from pathlib import Path

_spec = importlib.util.spec_from_file_location("brute_force", Path(__file__).parents[1] / "oracle/brute_force.py")
oracle = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(oracle)

PRODUCTS = [  # illustrative catalogue covering every rule type (not real lender data)
    ("HDFC Bank", "Personal Loan", 25000, None, False, 21, 60, None, 9.99, []),
    ("ICICI Bank", "Personal Loan (Salaried)", 30000, 700, False, 21, 58, ["Salaried"], 10.5, []),
    ("ICICI Bank", "Personal Loan (Self-Employed)", 40000, 720, False, 23, 65, ["Self-Employed", "Business"], 12.0,
     [{"text": "2 years in current business", "depends_on": ["business_vintage"]}]),
    ("Kotak Mahindra Bank", "Personal Loan", 30000, 750, False, 21, 60, None, 10.99,
     [{"text": "Minimum ₹25,000 for Kotak salary account holders", "depends_on": ["bank_relationship"]}]),
    ("NTC Lender", "First Loan", 20000, None, True, 21, 45, ["Business"], 18.0, []),
    ("Prime Bank", "Prime Personal Loan", 100000, 780, False, 25, 55, ["Salaried"], 9.5, []),
]


def _seed_products(db):
    for lender, name, inc, cs, ntc, amin, amax, types, rate, soft in PRODUCTS:
        db.execute(
            "INSERT INTO loan_products (product_key, lender_name, product_name, source_url, min_monthly_income,"
            " min_credit_score, accepts_ntc, min_age, max_age, employment_types, interest_rate_min, interest_rate_max,"
            " soft_rules, extraction_method, criteria_hash)"
            " VALUES (md5(%s), %s, %s, 'https://example.invalid', %s, %s, %s, %s, %s, %s::employment_t[], %s, %s, %s, 'llm', md5(%s))",
            (lender + name, lender, name, inc, cs, ntc, amin, amax, types, rate, rate, json.dumps(soft), name))


def _load_sample(go_ingest) -> str:
    result = go_ingest(Path("data/users.csv").read_bytes())  # the Go ingestion pipeline
    assert result["status"] == "LOADED"
    return result["batch_id"]


def test_optimised_pipeline_equals_brute_force_on_sample_file(db, workflow_b, go_ingest, batch_status):
    _seed_products(db)
    batch_id = _load_sample(go_ingest)
    run = workflow_b(batch_id)

    users = [dict(zip(("user_id", "monthly_income", "credit_score", "age", "employment_status"), r, strict=True))
             for r in db.execute("SELECT user_id, monthly_income, credit_score, age, employment_status::text FROM users")]
    products = [dict(p, employment_types=p["employment_types"]) for p in run["products"]]
    expected = oracle.all_pairs(users, products)
    got = set(db.execute("SELECT user_id, product_id FROM matches").fetchall())
    assert got == expected
    funnel = run["result"]["funnel"]
    assert funnel["users"] == 10_000 and funnel["naive_pairs"] == 60_000
    assert funnel["matches"] == len(expected) == run["saved"]["matches"]
    assert funnel["classes"] < 300, "coordinate compression: 10,000 users collapse to ~229 classes"
    assert funnel["llm_keys"] == 0, "soft rules here need data we don't hold → LIKELY, never an LLM call"
    assert batch_status(batch_id) == "MATCHED"
    likely = db.execute("SELECT count(*) FROM matches WHERE status = 'LIKELY' AND jsonb_array_length(unverified) > 0").fetchone()[0]
    assert likely == funnel["likely"] > 0

    # Every LIKELY match here is blocked by one askable fact → the plan can unlock all of them.
    plan = db.execute("SELECT detail->'question_plan' FROM pipeline_events"
                      " WHERE batch_id = %s AND stage = 'match' AND status = 'completed'", (batch_id,)).fetchone()[0]
    assert plan == funnel["question_plan"]
    assert {q["id"] for q in plan["by_question"]} == {"business_vintage", "bank_accounts"}
    assert plan["unlockable_matches"] == likely
    likely_users = db.execute("SELECT count(DISTINCT user_id) FROM matches WHERE status = 'LIKELY'").fetchone()[0]
    assert plan["users_to_ask"] <= likely_users


def test_rematching_is_idempotent_and_keeps_notified_flags(db, workflow_b, go_ingest):
    _seed_products(db)
    batch_id = _load_sample(go_ingest)
    workflow_b(batch_id)
    db.execute("UPDATE matches SET notified_at = now() WHERE user_id = (SELECT min(user_id) FROM matches)")
    db.execute("UPDATE ingest_batches SET status = 'LOADED' WHERE id = %s", (batch_id,))  # simulate a replay
    again = workflow_b(batch_id)
    assert again["saved"]["new_matches"] == 0 and again["saved"]["removed"] == 0
    assert db.execute("SELECT count(*) FROM matches WHERE notified_at IS NOT NULL").fetchone()[0] > 0


def test_sweeper_finds_stalled_batches(db, sql, new_batch):
    batch_id = new_batch()
    db.execute("UPDATE ingest_batches SET status='LOADED', updated_at = now() - interval '5 minutes' WHERE id=%s", (batch_id,))
    assert sql("b_find_stalled") == [{"batch_id": batch_id}]


def test_llm_judgment_cache_roundtrip(db, sql):
    _seed_products(db)
    pid = db.execute("SELECT min(id) FROM loan_products").fetchone()[0]
    rows = [{"cache_key": "k1", "product_id": pid, "verdict": "PASS", "rationale": "r", "model": "m"},
            {"cache_key": "k2", "product_id": pid, "verdict": "MAYBE", "rationale": "", "model": "m"}]
    assert len(sql("b_save_judgments", rows)) == 1  # invalid verdict filtered
    assert sql("b_lookup_judgments", ["k1", "k2", "k3"]) == [{"judgments": {"k1": "PASS"}}]
