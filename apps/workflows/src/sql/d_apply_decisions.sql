-- Apply the re-check of ONE person's LIKELY matches in a single set-based statement.
--   unlock → ELIGIBLE, decided_by 'DECLARED', nothing left to confirm
--   narrow → still LIKELY with fewer conditions          reject → match deleted
-- Only rows still LIKELY are touched, so a double submit can't count an unlock twice.
-- Also adds the unlocks to user_declarations.unlocked and logs a 'confirm' event for the batch.
-- $1 user_id, $2 decisions JSON [{product_id, action, score, unverified}]
WITH dec AS (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(product_id bigint, action text, score real, unverified jsonb)
), removed AS (
  DELETE FROM matches m USING dec
  WHERE m.user_id = $1 AND m.product_id = dec.product_id AND dec.action = 'reject' AND m.status = 'LIKELY'
  RETURNING m.product_id
), changed AS (
  UPDATE matches m
     SET status     = CASE WHEN dec.action = 'unlock' THEN 'ELIGIBLE' ELSE 'LIKELY' END,
         decided_by = CASE WHEN dec.action = 'unlock' THEN 'DECLARED' ELSE m.decided_by END,
         unverified = CASE WHEN dec.action = 'unlock' THEN '[]'::jsonb ELSE coalesce(dec.unverified, m.unverified) END,
         score      = dec.score
    FROM dec
   WHERE m.user_id = $1 AND m.product_id = dec.product_id AND dec.action IN ('unlock', 'narrow') AND m.status = 'LIKELY'
  RETURNING m.product_id, m.status
), opened AS (
  SELECT count(*)::int AS n, coalesce(jsonb_agg(product_id ORDER BY product_id), '[]'::jsonb) AS ids
  FROM changed WHERE status = 'ELIGIBLE'
), decl AS (
  UPDATE user_declarations d SET unlocked = d.unlocked + (SELECT n FROM opened), updated_at = now()
  WHERE d.user_id = $1
  RETURNING d.batch_id
), ev AS (
  INSERT INTO pipeline_events (batch_id, stage, status, detail)
  SELECT batch_id, 'confirm', 'completed',
         jsonb_build_object('unlocked', (SELECT n FROM opened), 'flagged', false,
                            'narrowed', (SELECT count(*) FROM changed WHERE status = 'LIKELY'),
                            'removed', (SELECT count(*) FROM removed))
  FROM decl
)
SELECT (SELECT n FROM opened) AS unlocked, (SELECT ids FROM opened) AS unlocked_ids,
       (SELECT count(*)::int FROM changed WHERE status = 'LIKELY') AS narrowed,
       (SELECT count(*)::int FROM removed) AS removed;
