-- Apply the re-check of answered people's LIKELY matches, for the whole batch, in one statement.
-- Same rules as d_apply_decisions: unlock → ELIGIBLE/DECLARED, narrow → fewer conditions,
-- reject → deleted. Only rows still LIKELY are touched. Unlocks are added per person to
-- user_declarations.unlocked; one 'confirm' event records the batch totals.
-- $1 batch_id, $2 decisions JSON [{user_id, product_id, action, score, unverified}]
WITH dec AS (
  SELECT * FROM jsonb_to_recordset($2::jsonb)
           AS x(user_id text, product_id bigint, action text, score real, unverified jsonb)
), removed AS (
  DELETE FROM matches m USING dec
  WHERE m.user_id = dec.user_id AND m.product_id = dec.product_id AND dec.action = 'reject' AND m.status = 'LIKELY'
  RETURNING m.user_id
), changed AS (
  UPDATE matches m
     SET status     = CASE WHEN dec.action = 'unlock' THEN 'ELIGIBLE' ELSE 'LIKELY' END,
         decided_by = CASE WHEN dec.action = 'unlock' THEN 'DECLARED' ELSE m.decided_by END,
         unverified = CASE WHEN dec.action = 'unlock' THEN '[]'::jsonb ELSE coalesce(dec.unverified, m.unverified) END,
         score      = dec.score
    FROM dec
   WHERE m.user_id = dec.user_id AND m.product_id = dec.product_id
     AND dec.action IN ('unlock', 'narrow') AND m.status = 'LIKELY'
  RETURNING m.user_id, m.status
), per_user AS (
  SELECT user_id, count(*)::int AS n FROM changed WHERE status = 'ELIGIBLE' GROUP BY user_id
), decl AS (
  UPDATE user_declarations d SET unlocked = d.unlocked + pu.n, updated_at = now()
  FROM per_user pu WHERE d.user_id = pu.user_id
  RETURNING 1
), totals AS (
  SELECT (SELECT count(*)::int FROM changed WHERE status = 'ELIGIBLE') AS unlocked,
         (SELECT count(*)::int FROM changed WHERE status = 'LIKELY') AS narrowed,
         (SELECT count(*)::int FROM removed) AS removed,
         (SELECT count(*)::int FROM per_user) AS people
), ev AS (
  INSERT INTO pipeline_events (batch_id, stage, status, detail)
  SELECT $1::uuid, 'confirm', 'completed',
         jsonb_build_object('source', 'match', 'unlocked', unlocked, 'narrowed', narrowed, 'removed', removed,
                            'people', people, 'updated', (SELECT count(*) FROM decl))
  FROM totals WHERE jsonb_array_length($2::jsonb) > 0
)
SELECT $1::text AS batch_id, unlocked, narrowed, removed, people FROM totals;
