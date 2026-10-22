-- After SES accepted the "you now pre-qualify" email: stamp the unlocked matches as notified.
-- $1 user_id, $2 JSON array of product ids
UPDATE matches SET notified_at = now()
WHERE user_id = $1 AND product_id IN (SELECT jsonb_array_elements_text($2::jsonb)::bigint)
RETURNING product_id;
