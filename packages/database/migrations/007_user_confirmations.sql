-- Self-declared answers that unlock "to confirm" matches (workflow D).
-- A lender rule about data the CSV doesn't hold (work experience, employer type, existing bank
-- account...) makes a match LIKELY. Workflow C asks the person 1-3 questions chosen to unlock the
-- most offers; workflow D stores the answers here and re-checks only that person's LIKELY matches.
-- Answers are self-declared: the lender still verifies documents at application time.
CREATE TABLE IF NOT EXISTS user_declarations (
  user_id       text PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  batch_id      uuid REFERENCES ingest_batches(id),          -- the upload whose email asked
  answers       jsonb NOT NULL,                              -- {question_id: value}, see questions.js
  flagged       boolean NOT NULL DEFAULT false,              -- contradictory answers → ops review
  flag_reasons  jsonb NOT NULL DEFAULT '[]',
  unlocked      int NOT NULL DEFAULT 0,                      -- matches that became ELIGIBLE
  declared_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_declarations_batch_idx ON user_declarations (batch_id);

-- Which questions an email asked (NULL = no question link in that email).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS questions jsonb;

-- A match confirmed by the person's own answers is ELIGIBLE, decided_by = 'DECLARED'.
ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_decided_by_check;
ALTER TABLE matches ADD CONSTRAINT matches_decided_by_check
  CHECK (decided_by IN ('RULES', 'LLM', 'DECLARED'));
