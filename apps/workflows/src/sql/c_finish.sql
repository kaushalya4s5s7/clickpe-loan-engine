-- Close the batch: counts for the UI, NOTIFYING → DONE. $1 batch_id
WITH counts AS (
  SELECT count(*) FILTER (WHERE status = 'SENT') AS sent,
         count(*) FILTER (WHERE status = 'FAILED') AS failed,
         count(*) FILTER (WHERE status = 'PENDING') AS pending
  FROM notifications WHERE batch_id = $1::uuid
), ev AS (
  INSERT INTO pipeline_events (batch_id, stage, status, detail)
  SELECT $1::uuid, 'notify', 'completed', to_jsonb(counts) FROM counts
), done AS (
  UPDATE ingest_batches SET status = 'DONE', updated_at = now()
  WHERE id = $1::uuid AND status = 'NOTIFYING'
)
SELECT * FROM counts;
