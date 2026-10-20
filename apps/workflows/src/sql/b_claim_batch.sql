-- Compare-and-set claim with a 15-minute lease. Zero rows back = someone else owns it → stop.
-- $1 = batch_id
WITH claimed AS (
  UPDATE ingest_batches
     SET status = 'MATCHING', lease_until = now() + interval '15 minutes', updated_at = now()
   WHERE id = $1::uuid
     AND (status = 'LOADED' OR (status = 'MATCHING' AND lease_until < now()))
  RETURNING id
), ev AS (
  INSERT INTO pipeline_events (batch_id, stage, status) SELECT id, 'match', 'started' FROM claimed
)
SELECT id::text AS batch_id FROM claimed;
