"""Workflow A's SQL: upsert by stable key, retire vanished products, never wipe data on a broken page."""

from pathlib import Path


def _product(key, name, income=25000):
    return {"product_key": key, "product_name": name, "source_url": "https://x", "interest_rate_min": 9.99,
            "interest_rate_max": 24, "min_monthly_income": income, "min_credit_score": None, "accepts_ntc": False,
            "min_age": 21, "max_age": 60, "employment_types": ["Salaried"], "max_loan_amount": None,
            "max_tenure_months": None, "soft_rules": [], "evidence": {"age": "21 to 60"}, "criteria_hash": f"h{income}"}


def test_upsert_retire_and_empty_extraction_safety(db, sql):
    assert sql("a_save_products", "HDFC Bank", [_product("a", "PL"), _product("b", "PL Plus")], "llm")[0]["new_products"] == 2
    out = sql("a_save_products", "HDFC Bank", [_product("a", "PL", income=30000)], "llm")[0]
    assert (out["new_products"], out["retired"]) == (0, 1)
    assert db.execute("SELECT min_monthly_income, employment_types::text FROM loan_products WHERE product_key='a'").fetchone() == (30000, "{Salaried}")
    sql("a_save_products", "HDFC Bank", [], "llm")  # broken page → nothing extracted
    assert db.execute("SELECT count(*) FROM loan_products WHERE is_active").fetchone()[0] == 1


def test_page_state_and_seeded_sources(db, sql):
    db.execute((Path("packages/database/migrations/002_seed_crawl_sources.sql")).read_text())
    sources = sql("a_load_sources")
    assert len(sources) == 6 and {s["lender_name"] for s in sources} == {"HDFC Bank", "ICICI Bank", "Kotak Mahindra Bank"}
    url = sources[0]["url"]
    sql("a_save_page_state", url, "not_modified", '"etag-1"', "", "", "0", "")
    sql("a_save_page_state", url, "unchanged", '"etag-1"', "", "", "100", "")
    row = db.execute("SELECT etag, unchanged_runs, last_status FROM crawl_sources WHERE url=%s", (url,)).fetchone()
    assert row == ('"etag-1"', 2, "unchanged")
