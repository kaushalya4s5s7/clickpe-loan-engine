-- Treasure Hunt stage 1: "fetch the newly added users", already compressed into classes.
-- width_bucket maps each value to the interval between product thresholds (coordinate
-- compression); users in the same intervals on every attribute are identical to every product.
-- Credit NULL (new-to-credit) gets bucket 0. Returns one row: {classes:[...], users:n}.
-- $1 batch_id, $2 income cuts, $3 credit cuts, $4 age cuts (Postgres array literals of numbers)
SELECT coalesce(json_agg(c), '[]'::json) AS classes, coalesce(sum(c.n), 0)::int AS users
FROM (
  SELECT width_bucket(monthly_income, $2::numeric[])                  AS ib,
         coalesce(width_bucket(credit_score, $3::numeric[]), 0)       AS cb,
         width_bucket(age, $4::numeric[])                             AS ab,
         employment_status::text                                      AS emp,
         count(*)::int                                                AS n
  FROM users
  WHERE last_batch_id = $1::uuid
  GROUP BY 1, 2, 3, 4
) c;
