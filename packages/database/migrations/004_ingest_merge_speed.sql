-- Faster bulk merge (measured on 1M rows, docs/OPTIMIZATION.md §Ingest):
-- users.last_batch_id had a foreign key, which made Postgres run one referential-integrity check
-- per merged row (~2.7 s per 1M rows). Integrity is guaranteed instead by the single writer: only
-- ingestion sets last_batch_id, always to the batch it holds, and batches are never deleted.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_last_batch_id_fkey;
