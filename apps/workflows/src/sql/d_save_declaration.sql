-- Store a person's self-declared answers (merged with any earlier ones by the Code node).
-- Contradictory answers are kept for ops but flagged, and the batch timeline gets a 'confirm'
-- event straight away (nothing else happens for a flagged person). `unlocked` is cumulative and
-- only workflow D's apply step changes it.
-- $1 user_id, $2 batch_id ('' = none), $3 answers JSON, $4 flagged ('true'/'false'), $5 flag_reasons JSON
WITH saved AS (
  INSERT INTO user_declarations AS d (user_id, batch_id, answers, flagged, flag_reasons)
  VALUES ($1, nullif($2, '')::uuid, $3::jsonb, $4::boolean, $5::jsonb)
  ON CONFLICT (user_id) DO UPDATE
     SET batch_id = coalesce(EXCLUDED.batch_id, d.batch_id), answers = EXCLUDED.answers,
         flagged = EXCLUDED.flagged, flag_reasons = EXCLUDED.flag_reasons, updated_at = now()
  RETURNING d.user_id, d.batch_id, d.flagged
), ev AS (
  INSERT INTO pipeline_events (batch_id, stage, status, detail)
  SELECT batch_id, 'confirm', 'completed', jsonb_build_object('unlocked', 0, 'flagged', true)
  FROM saved WHERE flagged
)
SELECT user_id, batch_id::text AS batch_id, flagged FROM saved;
