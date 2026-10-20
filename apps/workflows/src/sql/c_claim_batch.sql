-- Only one notifier per batch: CAS MATCHED → NOTIFYING. Zero rows = already handled → stop.
-- $1 = batch_id
WITH claimed AS (
  UPDATE ingest_batches SET status = 'NOTIFYING', updated_at = now()
  WHERE id = $1::uuid AND status = 'MATCHED'
  RETURNING id
), ev AS (
  INSERT INTO pipeline_events (batch_id, stage, status) SELECT id, 'notify', 'started' FROM claimed
)
SELECT id::text AS batch_id FROM claimed;
