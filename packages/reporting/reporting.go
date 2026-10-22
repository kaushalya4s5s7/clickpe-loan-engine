// Package reporting is the read model for the operations console: overview numbers, the loan
// catalogue, and what a batch produced. It never writes; its tables have other owners (n8n
// workflows A/B/C/D, ingestion). A screen that needs a new number gets it here, never by letting a
// handler query tables directly.
package reporting

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"loanengine/packages/database"
)

type Overview struct {
	ActiveProducts int        `json:"active_products"`
	Lenders        int        `json:"lenders"`
	LastCrawlAt    *time.Time `json:"last_crawl_at"`
	Users          int64      `json:"users"`
	Matches        int64      `json:"matches"`
	EmailsSent     int64      `json:"emails_sent"`
	Uploads        int64      `json:"uploads"`
}

// GetOverview returns headline aggregates only — no personal data, so it can be public.
func GetOverview(ctx context.Context, q database.Querier) (Overview, error) {
	var o Overview
	err := q.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM loan_products WHERE is_active),
		(SELECT count(DISTINCT lender_name) FROM loan_products WHERE is_active),
		(SELECT max(at) FROM crawl_runs),
		(SELECT count(*) FROM users),
		(SELECT count(*) FROM matches),
		(SELECT count(*) FROM notifications WHERE status = 'SENT'),
		(SELECT count(*) FROM ingest_batches)`).Scan(
		&o.ActiveProducts, &o.Lenders, &o.LastCrawlAt, &o.Users, &o.Matches, &o.EmailsSent, &o.Uploads)
	return o, err
}

type Product struct {
	ID               int64           `json:"id"`
	LenderName       string          `json:"lender_name"`
	ProductName      string          `json:"product_name"`
	SourceURL        string          `json:"source_url"`
	InterestRateMin  *float64        `json:"interest_rate_min"`
	InterestRateMax  *float64        `json:"interest_rate_max"`
	MinMonthlyIncome *float64        `json:"min_monthly_income"`
	MinCreditScore   *int            `json:"min_credit_score"`
	AcceptsNTC       bool            `json:"accepts_ntc"`
	MinAge           *int            `json:"min_age"`
	MaxAge           *int            `json:"max_age"`
	EmploymentTypes  []string        `json:"employment_types"`
	MaxLoanAmount    *float64        `json:"max_loan_amount"`
	SoftRules        json.RawMessage `json:"soft_rules"`
	Evidence         json.RawMessage `json:"evidence"`
	LastSeenAt       time.Time       `json:"last_seen_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

// Products is the live catalogue, as workflow A last extracted it.
func Products(ctx context.Context, q database.Querier) ([]Product, error) {
	rows, err := q.Query(ctx, `SELECT id, lender_name, product_name, source_url, interest_rate_min::float8,
		interest_rate_max::float8, min_monthly_income::float8, min_credit_score, accepts_ntc, min_age, max_age,
		employment_types::text[], max_loan_amount::float8, soft_rules, evidence, last_seen_at, updated_at
		FROM loan_products WHERE is_active ORDER BY lender_name, product_name`)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Product, error) {
		var p Product
		return p, r.Scan(&p.ID, &p.LenderName, &p.ProductName, &p.SourceURL, &p.InterestRateMin, &p.InterestRateMax,
			&p.MinMonthlyIncome, &p.MinCreditScore, &p.AcceptsNTC, &p.MinAge, &p.MaxAge, &p.EmploymentTypes,
			&p.MaxLoanAmount, &p.SoftRules, &p.Evidence, &p.LastSeenAt, &p.UpdatedAt)
	})
	if out == nil {
		out = []Product{}
	}
	return out, err
}

type ProductMatches struct {
	LenderName  string `json:"lender_name"`
	ProductName string `json:"product_name"`
	Users       int64  `json:"users"`
	Eligible    int64  `json:"eligible"`
	Likely      int64  `json:"likely"`
}

type BatchSummary struct {
	UsersMatched  int64            `json:"users_matched"`
	EmailsSent    int64            `json:"emails_sent"`
	EmailsFailed  int64            `json:"emails_failed"`
	EmailsPending int64            `json:"emails_pending"`
	ByProduct     []ProductMatches `json:"by_product"`
}

// GetBatchSummary is what one upload produced: matches per product and the email outcome.
func GetBatchSummary(ctx context.Context, q database.Querier, batchID string) (BatchSummary, error) {
	var s BatchSummary
	err := q.QueryRow(ctx, `SELECT
		(SELECT count(DISTINCT user_id) FROM matches WHERE batch_id = $1::uuid),
		(SELECT count(*) FROM notifications WHERE batch_id = $1::uuid AND status = 'SENT'),
		(SELECT count(*) FROM notifications WHERE batch_id = $1::uuid AND status = 'FAILED'),
		(SELECT count(*) FROM notifications WHERE batch_id = $1::uuid AND status = 'PENDING')`, batchID).Scan(
		&s.UsersMatched, &s.EmailsSent, &s.EmailsFailed, &s.EmailsPending)
	if err != nil {
		return s, err
	}
	rows, err := q.Query(ctx, `SELECT p.lender_name, p.product_name, count(*),
		count(*) FILTER (WHERE m.status = 'ELIGIBLE'), count(*) FILTER (WHERE m.status = 'LIKELY')
		FROM matches m JOIN loan_products p ON p.id = m.product_id
		WHERE m.batch_id = $1::uuid GROUP BY p.lender_name, p.product_name ORDER BY 3 DESC`, batchID)
	if err != nil {
		return s, err
	}
	s.ByProduct, err = pgx.CollectRows(rows, pgx.RowToStructByPos[ProductMatches])
	if s.ByProduct == nil {
		s.ByProduct = []ProductMatches{}
	}
	return s, err
}

// Confirmations is how the "to confirm" questions went for one upload (workflow D). Answers are
// self-declared: "unlocked" means pre-qualified on the person's word, the lender still verifies.
type Confirmations struct {
	Asked    int64 `json:"asked"`    // sent emails that carried a question link
	Answered int64 `json:"answered"` // people who submitted answers
	Flagged  int64 `json:"flagged"`  // contradictory answers held for ops review, not used
	Unlocked int64 `json:"unlocked"` // matches that moved from LIKELY to ELIGIBLE on those answers
}

// GetBatchConfirmations is one round trip, scoped to the batch like GetBatchSummary.
func GetBatchConfirmations(ctx context.Context, q database.Querier, batchID string) (Confirmations, error) {
	var c Confirmations
	err := q.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM notifications WHERE batch_id = $1::uuid AND status = 'SENT' AND questions IS NOT NULL),
		d.answered, d.flagged, d.unlocked
		FROM (SELECT count(*) AS answered, count(*) FILTER (WHERE flagged) AS flagged, coalesce(sum(unlocked), 0) AS unlocked
		      FROM user_declarations WHERE batch_id = $1::uuid) d`, batchID).Scan(
		&c.Asked, &c.Answered, &c.Flagged, &c.Unlocked)
	return c, err
}
