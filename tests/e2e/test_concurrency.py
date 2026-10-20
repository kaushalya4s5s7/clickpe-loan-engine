"""Races that matter at scale, run for real: separate OS processes, separate DB connections."""

import json
import os
import subprocess
import tempfile
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _csv(first: int, last: int, salt: int) -> str:
    rows = "".join(f"U{i:06d},u{i}@gmail.com,{40000 + salt},750,Salaried,30\n" for i in range(first, last))
    return "user_id,email,monthly_income,credit_score,employment_status,age\n" + rows


def test_parallel_uploads_with_overlapping_people_never_deadlock_or_lose_rows(db, new_batch, go_binaries):
    """Four Go ingest processes at once, each overlapping its neighbours by 5,000 people. Without the
    merge lock this is the classic deadlock / duplicate-key setup; with it, every batch loads and the
    result is exactly the union, each person stamped by whichever batch committed last."""
    ids, files, procs = [], [], []
    env = {**os.environ, "DATABASE_URL": os.environ["TEST_DATABASE_URL"], "N8N_WEBHOOK_URL": ""}
    for k in range(4):
        ids.append(new_batch())
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
            f.write(_csv(k * 15_000, k * 15_000 + 20_000, k))
        files.append(f.name)
        procs.append(subprocess.Popen([str(go_binaries / "ingest_local"), "--batch", ids[-1], f.name], env=env,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
    results = []
    for p in procs:
        out, err = p.communicate(timeout=120)
        assert p.returncode == 0, err
        results.append(json.loads(out))
    for f in files:
        os.unlink(f)
    assert [r["status"] for r in results] == ["LOADED"] * 4
    assert db.execute("SELECT count(*) FROM users").fetchone()[0] == 3 * 15_000 + 20_000
    stamped = dict(db.execute("SELECT last_batch_id::text, count(*) FROM users GROUP BY 1").fetchall())
    assert set(stamped) <= set(ids) and sum(stamped.values()) == 65_000


def test_two_notifiers_racing_for_the_same_person_send_one_email(db, new_batch):
    """Two batches matched the same person with DIFFERENT offers; both workflow-C runs queue at once."""
    db.execute("INSERT INTO loan_products (product_key, lender_name, product_name, source_url, extraction_method, criteria_hash)"
               " VALUES ('a','A','P1','https://a','llm','h1'), ('b','B','P2','https://b','llm','h2')")
    db.execute("INSERT INTO users (user_id, email, email_deliverable, monthly_income, employment_status, age)"
               " VALUES ('U1','u1@gmail.com',true,50000,'Salaried',30)")
    bids = [new_batch(), new_batch()]
    # each batch matched U1 to a different product → different digest keys, so UNIQUE(user, digest) can't help
    db.execute("INSERT INTO matches (user_id, product_id, status, score, decided_by, batch_id) VALUES"
               " ('U1',1,'ELIGIBLE',80,'RULES',%s), ('U1',2,'ELIGIBLE',70,'RULES',%s)", (bids[0], bids[1]))
    queue = textwrap.dedent("""
        import sys, psycopg, pathlib
        q = pathlib.Path(sys.argv[2]).read_text()
        with psycopg.connect(sys.argv[1], autocommit=True) as c, psycopg.RawCursor(c) as cur:
            cur.execute("SELECT pg_sleep(0.5)")  # line both processes up
            cur.execute(q, [sys.argv[3], "false", "[]", "5"]); print(cur.fetchone())
    """)
    path = str(ROOT / "apps/workflows/src/sql/c_queue_notifications.sql")
    procs = [subprocess.Popen([os.sys.executable, "-c", queue, os.environ["TEST_DATABASE_URL"], path, bid],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for bid in bids]
    for p in procs:
        _, err = p.communicate(timeout=60)
        assert p.returncode == 0, err
    assert db.execute("SELECT count(*) FROM notifications WHERE user_id = 'U1'").fetchone()[0] == 1
