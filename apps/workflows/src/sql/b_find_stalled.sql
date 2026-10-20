-- Sweeper (every 2 min): batches whose doorbell was missed, or whose matcher died mid-run.
-- The 1-minute grace period gives the webhook path first chance, so the two rarely collide
-- (and when they do, the claim below lets only one win).
SELECT id::text AS batch_id
FROM ingest_batches
WHERE (status = 'LOADED' AND updated_at < now() - interval '1 minute')
   OR (status = 'MATCHING' AND lease_until < now())
ORDER BY created_at
LIMIT 1;  -- one batch per tick keeps each execution single-batch; ticks are 2 min apart
