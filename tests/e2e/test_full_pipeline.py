"""A → B → C on real bank-page snapshots with recorded LLM replies (no network, no n8n runtime).

Everything else is the production code path: the crawler JS, the validator, every workflow SQL
statement, the ingestion package, the matcher and the email renderer.
"""

import csv
import gzip
import io
import json
from pathlib import Path

FIX = Path(__file__).resolve().parents[1] / "fixtures"
LENDERS = {"HDFC Bank": ("hdfc", "hdfc_rates"), "ICICI Bank": ("icici", "icici_rates"),
           "Kotak Mahindra Bank": ("kotak", "kotak_rates")}
ALIASES = ["me+one@gmail.com", "me+two@gmail.com", "me+three@gmail.com"]


def _workflow_a(sql, js) -> dict:
    found = {}
    for lender, pages in LENDERS.items():
        sections = [js("crawl", "relevantSection", js("crawl", "htmlToText", gzip.decompress((FIX / "html" / f"{p}.html.gz").read_bytes()).decode()))
                    for p in pages]
        recorded = json.loads((FIX / "llm" / f"{pages[0]}.json").read_text())
        out = js("crawl", "validateProducts", recorded,
                 {"lender": lender, "sourceText": "\n".join(sections), "sourceUrl": f"https://{pages[0]}"})
        assert out["warnings"] == [], f"{lender}: every recorded fact must be backed by a verbatim quote: {out['warnings']}"
        sql("a_save_products", lender, out["products"], "llm")
        found[lender] = out["products"]
    return found


def _upload(go_ingest, rows: list[list]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["user_id", "name", "email", "monthly_income", "credit_score", "employment_status", "age"])
    w.writerows(rows)
    result = go_ingest(buf.getvalue())  # the Go ingestion pipeline
    assert result["status"] == "LOADED"
    return result["batch_id"]


def test_crawl_match_notify_end_to_end(db, sql, js, workflow_b, go_ingest, batch_status):
    products = _workflow_a(sql, js)
    icici_se = next(p for p in products["ICICI Bank"] if "Self" in p["product_name"])
    assert icici_se["min_monthly_income"] is None and icici_se["employment_types"] == ["Business", "Self-Employed"]
    assert db.execute("SELECT count(*) FROM loan_products WHERE is_active").fetchone()[0] == 4

    batch_id = _upload(go_ingest, [
        ["P1", "Priya Sharma", "p1@example.com", "₹62,000", 760, "Salaried", 34],      # HDFC, ICICI-S, Kotak
        ["P2", "Rahul Verma", "p2@example.com", "28000", 710, "Salaried", 26],         # HDFC only (income)
        ["P3", "Asha Patel", "p3@example.com", "1.5L", 720, "Business Owner", 40],     # ICICI self-employed
        ["P4", "Young Applicant", "p4@example.com", "45000", 800, "Salaried", 19],     # ICICI-S (18+) only
        ["P5", "Low Income", "p5@example.com", "15000", 650, "Salaried", 30],           # nothing
    ])
    run = workflow_b(batch_id)
    got = {}
    for user, product in db.execute("SELECT m.user_id, p.lender_name || ' / ' || p.product_name FROM matches m"
                                    " JOIN loan_products p ON p.id = m.product_id ORDER BY 1, 2"):
        got.setdefault(user, []).append(product)
    assert got == {
        "P1": ["HDFC Bank / Personal Loan", "ICICI Bank / Personal Loan (Salaried)", "Kotak Mahindra Bank / Personal Loan"],
        "P2": ["HDFC Bank / Personal Loan"],
        "P3": ["ICICI Bank / Personal Loan (Self-Employed)"],
        "P4": ["ICICI Bank / Personal Loan (Salaried)"],
    }
    funnel = run["result"]["funnel"]
    assert (funnel["users"], funnel["naive_pairs"], funnel["matches"]) == (5, 20, 6)
    # Kotak's "salary account holders from ₹25,000" depends on data we don't hold → never sent to the LLM
    assert funnel["llm_keys"] == 0

    # ---- workflow C
    assert sql("c_claim_batch", batch_id) == [{"batch_id": batch_id}]
    assert sql("c_queue_notifications", batch_id, "true", ALIASES, "3")[0] == {"users_with_new_matches": 4, "queued": 3}
    pending = sql("c_load_pending", batch_id)
    secret, now = "test-unsubscribe-secret-0123456789", 1_700_000_000
    emails, plans = [], []
    for n in pending:  # the "Render emails" node: plan questions, sign the link, render
        plan = js("questions", "planQuestions", n, n["products"], {p["product_id"]: p for p in n["products"]},
                  {"maxQuestions": 3, "maxCards": 5})
        url = js("questions", "confirmLink", "https://hooks.example", n["user_id"], secret, now) if plan["questions"] else None
        confirm = {"url": url, "questions": plan["questions"], "unlockable": plan["unlockable"], "lenders": plan["lenders"]} if url else None
        emails.append(js("email", "renderEmail", n, {"unsubscribeBase": "https://api/v1/unsubscribe", "secret": secret,
                                                     "now": now, "confirm": confirm}))
        plans.append(plan if url else None)
    priya = next(e for e, n in zip(emails, pending, strict=True) if n["user_id"] == "P1")
    priya_plan = next(p for p, n in zip(plans, pending, strict=True) if n["user_id"] == "P1")
    # All three of Priya's offers wait on facts the CSV lacks; three answers can confirm every one.
    assert priya_plan["questions"] == ["work_experience", "employer_type", "bank_accounts"]
    assert priya_plan["unlockable"] == 3 and sorted(priya_plan["lenders"]) == ["HDFC Bank", "ICICI Bank", "Kotak Mahindra Bank"]
    assert "https://hooks.example/webhook/confirm?t=c." in priya["html"] and "self-declared" in priya["text"]
    assert "Answer 3 quick questions to confirm up to 3 offers from" in priya["html"]
    assert "approved" not in priya["html"].lower()
    assert priya["subject"] == "Priya, 3 personal loans you may qualify for"
    assert "HDFC Bank" in priya["html"] and "Interest 9.99–16.5% p.a." in priya["html"]
    assert "₹62,000/month ≥ ₹25,000 minimum" in priya["html"]
    assert "At least one year of work experience" in priya["html"]  # Kotak's unverifiable rule shown honestly
    assert all(n["recipient"] in ALIASES for n in pending), "never a sample-CSV address"
    for n, plan in zip(pending, plans, strict=True):
        sql("c_mark_sent", str(n["notification_id"]), f"ses-{n['notification_id']}", json.dumps(plan["questions"]) if plan else "")
    asked = dict(db.execute("SELECT user_id, questions FROM notifications WHERE status = 'SENT'").fetchall())
    assert asked["P1"] == priya_plan["questions"], "Workflow D serves exactly the questions the email asked"
    assert sql("c_finish", batch_id)[0] == {"sent": 3, "failed": 0, "pending": 0}
    assert batch_status(batch_id) == "DONE"
