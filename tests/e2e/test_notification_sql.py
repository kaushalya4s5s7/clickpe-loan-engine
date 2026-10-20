"""Workflow C's SQL: test-mode aliasing, duplicate protection, suppression, frequency cap."""

import json

ALIASES = ["me+one@gmail.com", "me+two@gmail.com"]


def _setup(db, new_batch, n_users=3) -> str:
    batch_id = new_batch("MATCHED")
    db.execute("INSERT INTO loan_products (product_key, lender_name, product_name, source_url, extraction_method, criteria_hash)"
               " VALUES ('k','HDFC Bank','Personal Loan','https://x','llm','h')")
    for i in range(n_users):
        db.execute("INSERT INTO users (user_id, name, email, email_deliverable, monthly_income, credit_score, employment_status,"
                   " age, last_batch_id) VALUES (%s, 'Asha Rao', %s, false, 50000, 750, 'Salaried', 30, %s)",
                   (f"U{i}", f"user{i}@example.com", batch_id))
        db.execute("INSERT INTO matches (user_id, product_id, status, score, decided_by, batch_id)"
                   " VALUES (%s, 1, 'ELIGIBLE', 80, 'RULES', %s)", (f"U{i}", batch_id))
    return batch_id


def test_test_mode_never_emails_sample_addresses(db, sql, new_batch):
    batch_id = _setup(db, new_batch, 3)
    assert sql("c_claim_batch", batch_id) == [{"batch_id": batch_id}]
    assert sql("c_claim_batch", batch_id) == []
    assert sql("c_queue_notifications", batch_id, "true", ALIASES, "5") == [{"users_with_new_matches": 3, "queued": 2}]
    recipients = {r[0] for r in db.execute("SELECT recipient FROM notifications")}
    assert recipients == set(ALIASES), "one alias per user, sample addresses never used"


def test_production_mode_skips_undeliverable_addresses(db, sql, new_batch):
    batch_id = _setup(db, new_batch, 2)
    assert sql("c_queue_notifications", batch_id, "false", [], "5")[0]["queued"] == 0  # all @example.com


def test_no_duplicate_email_for_the_same_offer(db, sql, new_batch):
    batch_id = _setup(db, new_batch, 1)
    sql("c_queue_notifications", batch_id, "true", ALIASES, "5")
    pending = sql("c_load_pending", batch_id)
    assert len(pending) == 1 and pending[0]["products"][0]["lender_name"] == "HDFC Bank"
    sql("c_mark_sent", str(pending[0]["notification_id"]), "ses-123")
    assert sql("c_queue_notifications", batch_id, "true", ALIASES, "5")[0]["queued"] == 0  # matches now notified
    db.execute("UPDATE matches SET notified_at = NULL")  # even if a flag were lost, the unique digest blocks it
    assert sql("c_queue_notifications", batch_id, "true", ALIASES, "5")[0]["queued"] == 0
    counts = sql("c_finish", batch_id)[0]
    assert (counts["sent"], counts["failed"]) == (1, 0)


def test_suppressed_alias_is_skipped(db, sql, new_batch):
    batch_id = _setup(db, new_batch, 1)
    db.execute("INSERT INTO suppression (email_hash, reason) VALUES (encode(sha256('me+one@gmail.com'), 'hex'), 'unsubscribe')")
    assert sql("c_queue_notifications", batch_id, "true", ALIASES, "5")[0]["queued"] == 0


def test_failures_retry_then_give_up(db, sql, new_batch):
    batch_id = _setup(db, new_batch, 1)
    sql("c_queue_notifications", batch_id, "true", ALIASES, "5")
    nid = str(sql("c_load_pending", batch_id)[0]["notification_id"])
    assert [sql("c_mark_failed", nid, "Throttling")[0]["status"] for _ in range(3)] == ["PENDING", "PENDING", "FAILED"]


def test_frequency_cap_blocks_a_second_email_within_7_days(db, sql, new_batch):
    batch_id = _setup(db, new_batch, 1)
    db.execute("INSERT INTO notifications (user_id, digest_key, recipient, status, sent_at) VALUES ('U0','old','x','SENT', now())")
    assert sql("c_queue_notifications", batch_id, "true", ALIASES, "5")[0]["queued"] == 0
    assert json.loads(json.dumps(sql("c_load_pending", batch_id))) == []
