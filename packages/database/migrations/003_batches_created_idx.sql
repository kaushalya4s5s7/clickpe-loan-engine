-- Upload history ("latest first") without a sort over the whole table.
CREATE INDEX IF NOT EXISTS ingest_batches_created_idx ON ingest_batches (created_at DESC);
