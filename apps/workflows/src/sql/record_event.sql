-- $1 batch_id (nullable), $2 stage, $3 status, $4 detail JSON
INSERT INTO pipeline_events (batch_id, stage, status, detail)
VALUES (nullif($1, '')::uuid, $2, $3, coalesce(nullif($4, ''), '{}')::jsonb);
