-- Upsert one lender's validated products.
-- Stable product_key = same row across crawls (history of rate changes stays on one id).
-- Products of this lender NOT seen this time are deactivated — but only when the extraction
-- found something: an empty result means the page broke, and we keep yesterday's data.
-- $1 lender_name, $2 products JSON array, $3 extraction method
WITH incoming AS (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS p(
    product_key text, product_name text, source_url text, interest_rate_min numeric, interest_rate_max numeric,
    min_monthly_income numeric, min_credit_score smallint, accepts_ntc boolean, min_age smallint, max_age smallint,
    employment_types jsonb, max_loan_amount numeric, max_tenure_months smallint, soft_rules jsonb,
    evidence jsonb, criteria_hash text)
), upserted AS (
  INSERT INTO loan_products AS lp (
    product_key, lender_name, product_name, source_url, interest_rate_min, interest_rate_max,
    min_monthly_income, min_credit_score, accepts_ntc, min_age, max_age, employment_types,
    max_loan_amount, max_tenure_months, soft_rules, evidence, extraction_method, criteria_hash)
  SELECT product_key, $1, product_name, source_url, interest_rate_min, interest_rate_max,
         min_monthly_income, min_credit_score, coalesce(accepts_ntc, false), min_age, max_age,
         CASE WHEN jsonb_typeof(employment_types) = 'array' AND jsonb_array_length(employment_types) > 0
              THEN ARRAY(SELECT jsonb_array_elements_text(employment_types))::employment_t[] END,
         max_loan_amount, max_tenure_months, coalesce(soft_rules, '[]'), coalesce(evidence, '{}'), $3, criteria_hash
  FROM incoming
  ON CONFLICT (product_key) DO UPDATE SET
    product_name = EXCLUDED.product_name, source_url = EXCLUDED.source_url,
    interest_rate_min = EXCLUDED.interest_rate_min, interest_rate_max = EXCLUDED.interest_rate_max,
    min_monthly_income = EXCLUDED.min_monthly_income, min_credit_score = EXCLUDED.min_credit_score,
    accepts_ntc = EXCLUDED.accepts_ntc, min_age = EXCLUDED.min_age, max_age = EXCLUDED.max_age,
    employment_types = EXCLUDED.employment_types, max_loan_amount = EXCLUDED.max_loan_amount,
    max_tenure_months = EXCLUDED.max_tenure_months, soft_rules = EXCLUDED.soft_rules,
    evidence = EXCLUDED.evidence, extraction_method = EXCLUDED.extraction_method,
    criteria_hash = EXCLUDED.criteria_hash, is_active = true, last_seen_at = now(),
    updated_at = CASE WHEN lp.criteria_hash IS DISTINCT FROM EXCLUDED.criteria_hash
                        OR lp.interest_rate_min IS DISTINCT FROM EXCLUDED.interest_rate_min
                      THEN now() ELSE lp.updated_at END
  RETURNING product_key, (xmax = 0) AS is_new
), retired AS (
  UPDATE loan_products SET is_active = false, updated_at = now()
  WHERE lender_name = $1 AND is_active
    AND (SELECT count(*) FROM incoming) > 0
    AND product_key NOT IN (SELECT product_key FROM incoming)
  RETURNING id
)
SELECT (SELECT count(*) FROM upserted) AS products, (SELECT count(*) FROM upserted WHERE is_new) AS new_products,
       (SELECT count(*) FROM retired) AS retired;
