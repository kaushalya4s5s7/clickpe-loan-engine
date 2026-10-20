"""Python test harness: n8n's SQL + JavaScript, chained against the Go backend.

The backend is Go (unit-tested with `go test ./...`). These tests check the seams between runtimes:
the Go ingest binary loads data, then the exact SQL files and JS modules n8n runs process it,
compared with a brute-force oracle. Real Postgres (TEST_DATABASE_URL, must be a *_test database).
"""

import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parent
BIN = ROOT / "build" / "bin"
os.environ.setdefault("TEST_DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/loan_engine_test")
TEST_URL = os.environ["TEST_DATABASE_URL"]

_TABLES = ("pipeline_events", "notifications", "suppression", "llm_judgments", "matches", "users",
           "ingest_errors", "ingest_batches", "crawl_runs", "crawl_sources", "loan_products")


def _go_env(**extra) -> dict:
    return {**os.environ, "DATABASE_URL": TEST_URL, "N8N_WEBHOOK_URL": "", **extra}


@pytest.fixture(scope="session")
def go_binaries():
    """Build the Go command-line apps once per test session."""
    BIN.mkdir(parents=True, exist_ok=True)
    for app in ("migrate", "ingest_local"):
        subprocess.run(["go", "build", "-o", str(BIN / app), f"./apps/{app}"], cwd=ROOT, check=True)
    return BIN


@pytest.fixture(scope="session")
def db_schema(go_binaries):
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        if not conn.info.dbname.endswith("_test"):  # the schema is wiped below: never touch a real database
            pytest.exit(f"refusing to reset database '{conn.info.dbname}': TEST_DATABASE_URL must name a *_test database")
        conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
    subprocess.run([str(go_binaries / "migrate")], env=_go_env(), check=True, capture_output=True)


@pytest.fixture
def db(db_schema):
    conn = psycopg.connect(TEST_URL, autocommit=True)
    conn.execute(f"TRUNCATE {', '.join(_TABLES)} RESTART IDENTITY CASCADE")
    yield conn
    conn.close()


@pytest.fixture
def new_batch(db):
    """Create an ingest batch row (what the upload API does) and return its id."""

    def create(status: str = "CREATED") -> str:
        batch_id = str(uuid.uuid4())
        db.execute("INSERT INTO ingest_batches (id, filename, s3_key, size_bytes, status) VALUES (%s, 'f.csv', %s, 1, %s)",
                   (batch_id, f"uploads/{batch_id}/f.csv", status))
        return batch_id

    return create


@pytest.fixture
def go_ingest(db, go_binaries):
    """Run the Go ingestion pipeline (apps/ingest_local) on CSV text/bytes; returns its result JSON."""

    def run(content: str | bytes, batch_id: str | None = None) -> dict:
        data = content.encode() if isinstance(content, str) else content
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as f:
            f.write(data)
        try:
            args = [str(go_binaries / "ingest_local")] + (["--batch", batch_id] if batch_id else []) + [f.name]
            out = subprocess.run(args, env=_go_env(), check=True, capture_output=True, text=True)
            return json.loads(out.stdout)
        finally:
            os.unlink(f.name)

    return run


@pytest.fixture
def batch_status(db):
    return lambda batch_id: db.execute("SELECT status::text FROM ingest_batches WHERE id = %s", (batch_id,)).fetchone()[0]


@pytest.fixture
def sql(db):
    """Run apps/workflows/src/sql/<name>.sql exactly as n8n does: $1-style params, all passed as text."""

    def run(name: str, *params):
        query = (ROOT / "apps/workflows/src/sql" / f"{name}.sql").read_text()
        args = [p if p is None or isinstance(p, str) else json.dumps(p) for p in params]
        with psycopg.RawCursor(db, row_factory=dict_row) as cur:
            cur.execute(query, args)
            return cur.fetchall() if cur.description else []

    return run


@pytest.fixture
def js():
    """Call a function from apps/workflows/src/code/<module>.js (the code n8n runs) via node."""
    runner = ROOT / "apps/workflows/tests/run_module.js"

    def call(module: str, fn: str, *args):
        out = subprocess.run(["node", str(runner), module, fn], input=json.dumps(args, default=str),
                             capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    return call


@pytest.fixture
def workflow_b(sql, js):
    """Drive workflow B's nodes in order (Claim → Load products → Plan → Load classes → Match → Save)."""

    def run(batch_id: str, judgments: dict | None = None) -> dict:
        assert sql("b_claim_batch", batch_id) == [{"batch_id": batch_id}], "claim failed"
        products = sql("b_load_products")[0]["products"]
        cuts = js("matcher", "buildCuts", products)
        arrays = [js("matcher", "pgArray", cuts[k]) for k in ("income", "credit", "age")]
        loaded = sql("b_load_classes", batch_id, *arrays)[0]
        result = js("matcher", "matchClasses", loaded["classes"], products, cuts, judgments or {})
        saved = sql("b_save_matches", batch_id, result["rows"], *arrays, result["funnel"])[0]
        return {"products": products, "loaded": loaded, "result": result, "saved": saved}

    return run
