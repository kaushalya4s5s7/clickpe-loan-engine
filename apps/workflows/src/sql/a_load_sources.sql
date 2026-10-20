-- Pages to crawl, with the validators from the last run (for conditional GET).
SELECT url, lender_name, page_role, coalesce(etag, '') AS etag, coalesce(last_modified, '') AS last_modified,
       coalesce(section_hash, '') AS section_hash
FROM crawl_sources
ORDER BY lender_name, page_role;
