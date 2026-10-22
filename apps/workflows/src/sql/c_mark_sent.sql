-- After SES accepted the message. Also stamps the user's matches as notified, so the same
-- offers are never emailed again. $1 notification_id, $2 SES message id,
-- $3 JSON array of question ids the email asked ('' = no question link) — Workflow D serves only these.
WITH sent AS (
  UPDATE notifications SET status = 'SENT', sent_at = now(), ses_message_id = $2, attempts = attempts + 1,
                           questions = nullif($3, '')::jsonb
  WHERE id = $1::bigint AND status = 'PENDING'
  RETURNING user_id
)
UPDATE matches m SET notified_at = now()
FROM sent WHERE m.user_id = sent.user_id AND m.notified_at IS NULL
RETURNING m.product_id;
