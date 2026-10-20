-- Everything the renderer needs, one item per PENDING notification (bounded: LIMIT 500 per page).
-- $1 batch_id
SELECT n.id AS notification_id, n.user_id, n.recipient, u.name, u.monthly_income, u.credit_score,
       u.employment_status::text AS employment_status, u.age,
       (SELECT json_agg(x ORDER BY x.score DESC)
          FROM (SELECT m.score, m.status, m.unverified, p.product_name, p.lender_name, p.source_url,
                       p.interest_rate_min, p.interest_rate_max, p.min_monthly_income, p.min_credit_score,
                       p.min_age, p.max_age, p.employment_types::text[] AS employment_types, p.max_loan_amount
                  FROM matches m JOIN loan_products p ON p.id = m.product_id
                 WHERE m.user_id = n.user_id AND m.notified_at IS NULL) x) AS products
FROM notifications n
JOIN users u USING (user_id)
WHERE n.batch_id = $1::uuid AND n.status = 'PENDING'
ORDER BY n.id
LIMIT 500;
