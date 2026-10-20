-- Pick users with NEW (un-notified) matches and create one PENDING notification each.
-- Filters: marketing consent, suppression list, 7-day frequency cap, deliverable address.
-- TEST MODE (the brief: never email sample-CSV addresses): the recipient is rewritten to one of
-- our own Gmail +aliases, one alias per user, capped at $4 users. UNIQUE(user_id, digest_key)
-- makes a re-run a no-op: the same offer set can't be queued twice, and the partial unique index
-- (user_id, cap_week) means two notifiers racing for the same person can't both queue an email.
-- $1 batch_id, $2 test_mode ('true'/'false'), $3 test recipients JSON array, $4 max emails per run
WITH settings AS (
  SELECT $2::boolean AS test_mode, $3::jsonb AS aliases, $4::int AS cap
), candidates AS (
  SELECT m.user_id, u.email, u.email_deliverable,
         array_agg(m.product_id ORDER BY m.score DESC, m.product_id) AS products
  FROM matches m
  JOIN users u USING (user_id)
  WHERE m.batch_id = $1::uuid AND m.notified_at IS NULL AND u.consent_marketing
    AND NOT EXISTS (SELECT 1 FROM notifications n
                    WHERE n.user_id = m.user_id AND n.status = 'SENT' AND n.sent_at > now() - interval '7 days')
  GROUP BY m.user_id, u.email, u.email_deliverable
), addressed AS (
  SELECT c.*, row_number() OVER (ORDER BY c.user_id) AS rn,
         CASE WHEN s.test_mode
              THEN s.aliases ->> ((row_number() OVER (ORDER BY c.user_id) - 1)::int)
              ELSE c.email END AS recipient
  FROM candidates c CROSS JOIN settings s
  WHERE s.test_mode OR c.email_deliverable
), eligible AS (
  SELECT a.* FROM addressed a CROSS JOIN settings s
  WHERE a.recipient IS NOT NULL
    AND (NOT s.test_mode OR a.rn <= s.cap)
    AND NOT EXISTS (SELECT 1 FROM suppression x
                    WHERE x.email_hash = encode(sha256(convert_to(lower(a.recipient), 'UTF8')), 'hex'))
), inserted AS (
  INSERT INTO notifications (user_id, batch_id, digest_key, recipient)
  SELECT user_id, $1::uuid, md5(array_to_string(products, ',')), recipient FROM eligible
  ON CONFLICT DO NOTHING          -- either unique rule (same offer, or already emailed this week)
  RETURNING id
)
SELECT (SELECT count(*) FROM candidates) AS users_with_new_matches,
       (SELECT count(*) FROM inserted)   AS queued;
