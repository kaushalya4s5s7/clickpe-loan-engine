-- The entire active catalogue as ONE row holding a JSON array: n8n's cost is per item,
-- so a list travels as one item, not hundreds.
SELECT coalesce(json_agg(p ORDER BY p.id), '[]'::json) AS products
FROM (
  SELECT id, lender_name, product_name, source_url, interest_rate_min, interest_rate_max,
         min_monthly_income, min_credit_score, accepts_ntc, min_age, max_age,
         employment_types::text[] AS employment_types, max_loan_amount, soft_rules, criteria_hash
  FROM loan_products
  WHERE is_active
) p;
