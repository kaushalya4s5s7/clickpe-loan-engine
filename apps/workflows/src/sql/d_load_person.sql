-- Workflow D: everything the form and the re-check need for ONE person, as one row.
-- matches = all of the person's matches on active products (LIKELY ones carry the product's
-- soft_rules so unverified rule texts can be mapped back to questions). recipient = where
-- Workflow C last emailed them (already test-mode rewritten) — never users.email — and NULL
-- when that address has since been suppressed. Zero rows = unknown user.
-- $1 user_id
SELECT u.user_id, u.name, u.age, u.employment_status::text AS employment_status, u.monthly_income, u.credit_score,
       u.last_batch_id::text AS batch_id,
       d.answers AS declared, coalesce(d.flagged, false) AS flagged,
       (SELECT l.recipient
          FROM (SELECT n.recipient FROM notifications n
                 WHERE n.user_id = u.user_id AND n.status = 'SENT'
                 ORDER BY n.sent_at DESC NULLS LAST, n.id DESC LIMIT 1) l
         WHERE NOT EXISTS (SELECT 1 FROM suppression x
                           WHERE x.email_hash = encode(sha256(convert_to(lower(l.recipient), 'UTF8')), 'hex'))) AS recipient,
       (SELECT coalesce(json_agg(x ORDER BY x.score DESC, x.product_id), '[]'::json)
          FROM (SELECT m.product_id, m.status, m.score, m.unverified, m.decided_by,
                       p.lender_name, p.product_name, p.source_url, p.interest_rate_min, p.interest_rate_max,
                       p.max_loan_amount, p.min_monthly_income, p.min_credit_score, p.min_age, p.max_age,
                       p.employment_types::text[] AS employment_types,
                       CASE WHEN m.status = 'LIKELY' THEN p.soft_rules ELSE '[]'::jsonb END AS soft_rules
                  FROM matches m JOIN loan_products p ON p.id = m.product_id
                 WHERE m.user_id = u.user_id AND p.is_active) x) AS matches
FROM users u
LEFT JOIN user_declarations d USING (user_id)
WHERE u.user_id = $1;
