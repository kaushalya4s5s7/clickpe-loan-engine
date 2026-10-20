-- Race-free frequency cap. The "not emailed in the last 7 days" check in workflow C is a read,
-- so two notifiers running at the same moment for different batches could both pass it and
-- email the same person twice. A UNIQUE index can't race: at most one live notification per
-- person per IST calendar week. (The rolling 7-day check stays as the friendlier rule.)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS cap_week date NOT NULL
  DEFAULT (date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata'))::date;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_per_week
  ON notifications (user_id, cap_week) WHERE status IN ('PENDING', 'SENT');
