-- One atomic statement: expand class results back to users, upsert `matches`, drop matches the
-- batch's users no longer qualify for, record the funnel, and mark the batch MATCHED.
-- n8n ships ~hundreds of class rows; Postgres expands them to tens of thousands of pairs
-- (set-based, one round trip) instead of n8n sending one INSERT per pair.
-- Existing pairs keep first_matched_at and notified_at, so nobody is emailed twice for the same offer.
-- A pair the person already confirmed with their own answers (workflow D, decided_by DECLARED) keeps
-- that status while it still passes the hard rules; a re-match must not send it back to LIKELY.
-- $1 batch_id, $2 class rows JSON, $3/$4/$5 income/credit/age cuts, $6 funnel JSON
WITH cls AS (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS c(
    ib int, cb int, ab int, emp text, product_id bigint, status text, score real,
    unverified jsonb, decided_by text)
), batch_users AS (
  SELECT user_id,
         width_bucket(monthly_income, $3::numeric[])            AS ib,
         coalesce(width_bucket(credit_score, $4::numeric[]), 0) AS cb,
         width_bucket(age, $5::numeric[])                       AS ab,
         employment_status::text                                AS emp
  FROM users WHERE last_batch_id = $1::uuid
), fresh AS (
  SELECT u.user_id, c.product_id, c.status, c.score, c.unverified, c.decided_by
  FROM batch_users u JOIN cls c USING (ib, cb, ab, emp)
), removed AS (
  DELETE FROM matches m USING batch_users u
  WHERE m.user_id = u.user_id
    AND NOT EXISTS (SELECT 1 FROM fresh f WHERE f.user_id = m.user_id AND f.product_id = m.product_id)
  RETURNING 1
), upserted AS (
  INSERT INTO matches (user_id, product_id, status, score, unverified, decided_by, batch_id)
  SELECT user_id, product_id, status, score, unverified, decided_by, $1::uuid FROM fresh
  ON CONFLICT (user_id, product_id) DO UPDATE
     SET status = EXCLUDED.status, score = EXCLUDED.score, unverified = EXCLUDED.unverified,
         decided_by = EXCLUDED.decided_by, batch_id = EXCLUDED.batch_id
   WHERE matches.decided_by <> 'DECLARED' OR EXCLUDED.status = 'ELIGIBLE'
  RETURNING (xmax = 0) AS is_new
), counts AS (
  SELECT count(*) AS matches, count(*) FILTER (WHERE is_new) AS new_matches,
         (SELECT count(*) FROM removed) AS removed
  FROM upserted
), done AS (
  UPDATE ingest_batches SET status = 'MATCHED', lease_until = NULL, updated_at = now()
  WHERE id = $1::uuid AND status = 'MATCHING'
  RETURNING id
), ev AS (
  INSERT INTO pipeline_events (batch_id, stage, status, detail)
  SELECT $1::uuid, 'match', 'completed',
         $6::jsonb || jsonb_build_object('stored_matches', matches, 'new_matches', new_matches, 'removed', removed)
  FROM counts
)
SELECT $1 AS batch_id, matches, new_matches, removed, (SELECT count(*) FROM done) AS transitioned FROM counts;
