-- After fetching one page: remember validators + section hash, log the run.
-- $1 url, $2 outcome, $3 etag, $4 last_modified, $5 section_hash, $6 bytes fetched, $7 error
WITH upd AS (
  UPDATE crawl_sources
  SET etag = nullif($3, ''), last_modified = nullif($4, ''),
      section_hash = coalesce(nullif($5, ''), section_hash),
      unchanged_runs = CASE WHEN $2 IN ('not_modified', 'unchanged') THEN unchanged_runs + 1 ELSE 0 END,
      last_status = $2, last_crawled_at = now()
  WHERE url = $1
)
INSERT INTO crawl_runs (url, outcome, bytes_fetched, error)
VALUES ($1, $2, nullif($6, '')::int, nullif($7, ''))
RETURNING id;
