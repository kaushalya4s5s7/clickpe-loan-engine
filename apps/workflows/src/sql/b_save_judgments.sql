-- $1 = JSON array of {cache_key, product_id, verdict, rationale, model}
INSERT INTO llm_judgments (cache_key, product_id, verdict, rationale, model)
SELECT cache_key, product_id, verdict, rationale, model
FROM jsonb_to_recordset($1::jsonb)
     AS j(cache_key text, product_id bigint, verdict text, rationale text, model text)
WHERE verdict IN ('PASS', 'FAIL', 'UNKNOWN')
ON CONFLICT (cache_key) DO NOTHING
RETURNING cache_key;
