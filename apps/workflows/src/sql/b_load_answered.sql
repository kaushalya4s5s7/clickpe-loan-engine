-- After matching: people in this batch who already answered Workflow D's questions (and weren't
-- flagged), with their LIKELY matches, so B re-checks new "to confirm" offers with those answers.
-- Always ONE row (people = [] when nobody answered) so the workflow keeps flowing to C.
-- Same per-person shape as d_load_person, so confirm.js judges both the same way.
-- $1 batch_id
SELECT $1::text AS batch_id, coalesce(json_agg(p), '[]'::json) AS people
FROM (
  SELECT u.user_id, u.age, u.employment_status::text AS employment_status, u.monthly_income, u.credit_score,
         d.answers AS declared,
         (SELECT json_agg(x ORDER BY x.product_id)
            FROM (SELECT m.product_id, m.status, m.score, m.unverified, m.decided_by, p.lender_name, p.product_name,
                         p.interest_rate_min, p.interest_rate_max, p.soft_rules
                    FROM matches m JOIN loan_products p ON p.id = m.product_id
                   WHERE m.user_id = u.user_id AND m.status = 'LIKELY' AND p.is_active) x) AS matches
  FROM users u
  JOIN user_declarations d USING (user_id)
  WHERE u.last_batch_id = $1::uuid AND NOT d.flagged
    AND EXISTS (SELECT 1 FROM matches m WHERE m.user_id = u.user_id AND m.status = 'LIKELY')
  ORDER BY u.user_id
  LIMIT 2000
) p;
