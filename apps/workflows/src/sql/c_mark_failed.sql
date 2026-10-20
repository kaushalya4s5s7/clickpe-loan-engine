-- SES rejected the message (after the node's own retries). Permanent after 3 attempts.
-- $1 notification_id, $2 error text
UPDATE notifications
SET attempts = attempts + 1, last_error = left($2, 500),
    status = CASE WHEN attempts + 1 >= 3 THEN 'FAILED' ELSE 'PENDING' END
WHERE id = $1::bigint
RETURNING id, status;
