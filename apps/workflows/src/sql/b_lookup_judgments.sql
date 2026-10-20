-- Stage 3 cache lookup. $1 = JSON array of cache keys. Returns one row: {judgments: {key: verdict}}.
SELECT coalesce(json_object_agg(cache_key, verdict), '{}'::json) AS judgments
FROM llm_judgments
WHERE cache_key IN (SELECT jsonb_array_elements_text($1::jsonb));
