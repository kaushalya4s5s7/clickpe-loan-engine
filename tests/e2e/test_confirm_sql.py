"""Workflow D's SQL + JS, chained as the n8n nodes chain them, against real Postgres.

Load person → check answers → save declaration → (judge) → decide → apply → mark notified.
The LLM judge is the only node replaced: its verdicts are given directly.
"""

import json

RULE_EXP = "Minimum of 2 years of total work experience"
RULE_BANK = "Salary account with Kotak Mahindra Bank"
RULE_EMPLOYER = "Employed with an MNC or public limited company"
RULE_OTHER = "Applicant must be a practising doctor"

PRODUCTS = [  # lender, rate, soft rules
    ("HDFC Bank", 10.0, [{"text": RULE_EXP, "depends_on": ["work_experience"]}]),
    ("Kotak Mahindra Bank", 11.0, [{"text": RULE_BANK, "depends_on": ["bank_relationship"]}]),
    ("ICICI Bank", 10.5, [{"text": RULE_EXP, "depends_on": ["work_experience"]},
                          {"text": RULE_EMPLOYER, "depends_on": ["employer_type"]}]),
    ("Doctor Bank", 9.0, [{"text": RULE_OTHER, "depends_on": ["other"]}]),
    ("SBI", 13.0, []),
]


def _seed(db, new_batch, recipient="me+one@gmail.com"):
    batch_id = new_batch("DONE")
    ids = []
    for lender, rate, soft in PRODUCTS:
        ids.append(db.execute(
            "INSERT INTO loan_products (product_key, lender_name, product_name, source_url, interest_rate_min, interest_rate_max,"
            " min_monthly_income, soft_rules, extraction_method, criteria_hash)"
            " VALUES (md5(%s), %s, 'Personal Loan', 'https://example.invalid/pl', %s, %s, 25000, %s, 'llm', 'h') RETURNING id",
            (lender, lender, rate, rate + 8, json.dumps(soft))).fetchone()[0])
    db.execute("INSERT INTO users (user_id, name, email, email_deliverable, monthly_income, credit_score, employment_status, age,"
               " last_batch_id) VALUES ('U1', 'Asha Rao', 'asha@example.com', false, 60000, 760, 'Salaried', 30, %s)", (batch_id,))
    for pid, (_, rate, soft) in zip(ids, PRODUCTS, strict=True):
        texts = [r["text"] for r in soft]
        status = "LIKELY" if texts else "ELIGIBLE"
        db.execute("INSERT INTO matches (user_id, product_id, status, score, unverified, decided_by, batch_id, notified_at)"
                   " VALUES ('U1', %s, %s, %s, %s, 'RULES', %s, now() - interval '1 day')",
                   (pid, status, 100 - rate * 2 - 5 * len(texts), json.dumps(texts), batch_id))
    if recipient:
        db.execute("INSERT INTO notifications (user_id, batch_id, digest_key, recipient, status, sent_at, questions)"
                   " VALUES ('U1', %s, 'd1', %s, 'SENT', now(), '[\"work_experience\"]')", (batch_id, recipient))
    return batch_id, dict(zip([p[0] for p in PRODUCTS], ids, strict=True))


def _plan(js, person):
    inputs = js("confirm", "planInputs", person)
    return js("questions", "planQuestions", inputs["user"], inputs["matches"], inputs["productsById"],
              {"maxQuestions": 3, "maxCards": 5})


def test_answers_unlock_matches_end_to_end(db, sql, js, new_batch):
    batch_id, pid = _seed(db, new_batch)

    # Load person: one row, all matches, soft rules only on LIKELY ones, C's recipient.
    [person] = sql("d_load_person", "U1")
    assert person["batch_id"] == batch_id and person["recipient"] == "me+one@gmail.com"
    assert person["declared"] is None and person["flagged"] is False
    assert len(person["matches"]) == 5
    sbi = next(m for m in person["matches"] if m["lender_name"] == "SBI")
    assert sbi["status"] == "ELIGIBLE" and sbi["soft_rules"] == []
    plan = _plan(js, person)
    assert "work_experience" in plan["questions"]

    # Check answers (Code node): parse + sanity checks.
    body = {"t": "token", "total_experience_years": "6", "current_job_years": "3", "employer_type": "mnc",
            "bank_accounts": "Kotak Mahindra Bank"}
    parsed = js("confirm", "parseAnswers", body, person, plan)
    assert parsed["errors"] == {}
    answers = js("confirm", "mergeAnswers", person["declared"], parsed["answers"])
    assert js("confirm", "sanityCheck", answers, person) == []

    # Save declaration.
    saved = sql("d_save_declaration", "U1", person["batch_id"], answers, "false", [])
    assert saved == [{"user_id": "U1", "batch_id": batch_id, "flagged": False}]
    assert db.execute("SELECT count(*) FROM pipeline_events WHERE stage = 'confirm'").fetchone()[0] == 0

    # Build judge items → (LLM) → decide. HDFC passes, Kotak fails, ICICI: experience passes, employer UNKNOWN.
    items = js("confirm", "judgeItems", person, answers)
    by_product = {i["product_id"]: i for i in items}
    assert pid["Doctor Bank"] not in by_product, "an 'other' rule is never sent to the judge"
    verdicts = {pid["HDFC Bank"]: ["PASS"], pid["Kotak Mahindra Bank"]: ["FAIL"], pid["ICICI Bank"]: ["PASS", "UNKNOWN"]}
    judgments = [{"cache_key": i["cache_key"], "verdict": verdicts[i["product_id"]][int(i["cache_key"].split(":")[1])]}
                 for i in items]
    decided = js("confirm", "decide", person, items, judgments)
    assert {u["action"] for u in decided["updates"]} == {"unlock", "reject", "narrow"}

    # Apply decisions: one statement.
    [applied] = sql("d_apply_decisions", "U1", decided["updates"])
    assert applied == {"unlocked": 1, "unlocked_ids": [pid["HDFC Bank"]], "narrowed": 1, "removed": 1}
    rows = {r[0]: r[1:] for r in db.execute("SELECT product_id, status, decided_by, unverified, score FROM matches WHERE user_id = 'U1'")}
    assert rows[pid["HDFC Bank"]] == ("ELIGIBLE", "DECLARED", [], 80.0)
    assert pid["Kotak Mahindra Bank"] not in rows, "a FAIL on the person's own answer removes the match"
    assert rows[pid["ICICI Bank"]] == ("LIKELY", "RULES", [RULE_EMPLOYER], 74.0)
    assert rows[pid["Doctor Bank"]][0] == "LIKELY" and rows[pid["SBI"]][0] == "ELIGIBLE"
    assert db.execute("SELECT unlocked, flagged FROM user_declarations WHERE user_id = 'U1'").fetchone() == (1, False)
    event = db.execute("SELECT batch_id::text, status, detail FROM pipeline_events WHERE stage = 'confirm'").fetchall()
    assert event == [(batch_id, "completed", {"unlocked": 1, "flagged": False, "narrowed": 1, "removed": 1})]

    # A double submit can't unlock (or count) anything twice.
    [again] = sql("d_apply_decisions", "U1", decided["updates"])
    assert again["unlocked"] == 0 and again["unlocked_ids"] == []
    assert db.execute("SELECT unlocked FROM user_declarations WHERE user_id = 'U1'").fetchone()[0] == 1

    # Email sent → stamp the unlocked matches.
    before = db.execute("SELECT notified_at FROM matches WHERE product_id = %s", (pid["HDFC Bank"],)).fetchone()[0]
    assert sql("d_mark_notified", "U1", applied["unlocked_ids"]) == [{"product_id": pid["HDFC Bank"]}]
    after = db.execute("SELECT notified_at FROM matches WHERE product_id = %s", (pid["HDFC Bank"],)).fetchone()[0]
    assert after > before

    # The next visit sees the stored answers (pre-filled form) and the unlocked match as ELIGIBLE.
    [person2] = sql("d_load_person", "U1")
    assert person2["declared"]["work_experience"] == {"total_experience_years": 6, "current_job_years": 3}
    html = js("confirm", "resultPage", person2, [m for m in person2["matches"] if m["decided_by"] == "DECLARED"], {})
    assert "Pre-qualified based on your answers" in html


def test_contradictory_answers_are_flagged_and_logged(db, sql, js, new_batch):
    batch_id, _ = _seed(db, new_batch)
    [person] = sql("d_load_person", "U1")
    answers = {"work_experience": {"total_experience_years": 20, "current_job_years": 2}}  # age 30: at most 12
    reasons = js("confirm", "sanityCheck", answers, person)
    assert len(reasons) == 1
    saved = sql("d_save_declaration", "U1", person["batch_id"], answers, "true", reasons)
    assert saved[0]["flagged"] is True
    assert db.execute("SELECT flag_reasons, unlocked FROM user_declarations").fetchone() == (reasons, 0)
    assert db.execute("SELECT batch_id::text, detail FROM pipeline_events WHERE stage = 'confirm'").fetchall() == [
        (batch_id, {"unlocked": 0, "flagged": True})]
    # Fixed answers later replace the flagged ones.
    sql("d_save_declaration", "U1", person["batch_id"], {"city": "Pune"}, "false", [])
    assert db.execute("SELECT answers, flagged, flag_reasons FROM user_declarations").fetchone() == ({"city": "Pune"}, False, [])
    # Batch-status style counts (Go API reads these): answered / flagged / unlocked by batch.
    row = db.execute("SELECT count(*), count(*) FILTER (WHERE flagged), coalesce(sum(unlocked), 0) FROM user_declarations"
                     " WHERE batch_id = %s", (batch_id,)).fetchone()
    assert row == (1, 0, 0)


def test_email_goes_only_to_cs_last_unsuppressed_recipient(db, sql, new_batch):
    _seed(db, new_batch, recipient=None)
    assert sql("d_load_person", "U1")[0]["recipient"] is None, "never users.email: no SENT notification → no email"
    db.execute("INSERT INTO notifications (user_id, digest_key, recipient, status, sent_at, cap_week) VALUES"
               " ('U1', 'old', 'old@gmail.com', 'SENT', now() - interval '20 days', '2026-01-05'),"
               " ('U1', 'new', 'new@gmail.com', 'SENT', now() - interval '1 day', '2026-01-12'),"
               " ('U1', 'failed', 'failed@gmail.com', 'FAILED', NULL, '2026-01-19')")
    assert sql("d_load_person", "U1")[0]["recipient"] == "new@gmail.com"
    db.execute("INSERT INTO suppression (email_hash, reason) VALUES (encode(sha256('new@gmail.com'), 'hex'), 'unsubscribe')")
    assert sql("d_load_person", "U1")[0]["recipient"] is None, "an unsubscribed address is never used"


def test_unknown_user_and_inactive_products(db, sql, new_batch):
    _, pid = _seed(db, new_batch)
    assert sql("d_load_person", "nobody") == []
    db.execute("UPDATE loan_products SET is_active = false WHERE id = %s", (pid["HDFC Bank"],))
    lenders = {m["lender_name"] for m in sql("d_load_person", "U1")[0]["matches"]}
    assert "HDFC Bank" not in lenders and len(lenders) == 4
    # Applying decisions with nothing to do still logs the confirm event and changes nothing.
    sql("d_save_declaration", "U1", "", {"city": "Pune"}, "false", [])
    assert sql("d_apply_decisions", "U1", []) == [{"unlocked": 0, "unlocked_ids": [], "narrowed": 0, "removed": 0}]


def test_rematch_keeps_a_match_the_person_confirmed(db, sql, new_batch):
    """Workflow B re-matching the batch must not send a DECLARED match back to LIKELY."""
    batch_id, pid = _seed(db, new_batch)
    db.execute("UPDATE matches SET status = 'ELIGIBLE', decided_by = 'DECLARED', unverified = '[]', score = 80"
               " WHERE user_id = 'U1' AND product_id = %s", (pid["HDFC Bank"],))
    likely = {"ib": 1, "cb": 1, "ab": 1, "emp": "Salaried", "status": "LIKELY", "score": 75.0,
              "unverified": [RULE_EXP], "decided_by": "RULES"}
    rows = [{**likely, "product_id": pid["HDFC Bank"]}, {**likely, "product_id": pid["ICICI Bank"]}]
    sql("b_save_matches", batch_id, rows, "{0}", "{0}", "{0}", {})

    got = dict(db.execute("SELECT product_id, status || '/' || decided_by FROM matches WHERE user_id = 'U1'").fetchall())
    assert got[pid["HDFC Bank"]] == "ELIGIBLE/DECLARED"      # kept
    assert got[pid["ICICI Bank"]] == "LIKELY/RULES"          # ordinary rows still follow the matcher
    assert pid["SBI"] not in got                              # and stale ones are still removed
