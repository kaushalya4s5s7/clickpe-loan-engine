-- Answers are kept for future use (B re-checks new offers with them; C never asks twice), and can
-- be searched, e.g. everyone who declared 5+ years: answers @? '$.work_experience ? (@.total_experience_years >= 5)'.
CREATE INDEX IF NOT EXISTS user_declarations_answers_idx ON user_declarations USING gin (answers jsonb_path_ops);
