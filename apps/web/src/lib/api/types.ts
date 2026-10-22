// Contracts of the Loan Engine API (apps/api). Kept in one file so a backend change is one diff here.

export type BatchStatus =
  | "CREATED" | "UPLOADED" | "PARSING" | "LOADED" | "MATCHING"
  | "MATCHED" | "NOTIFYING" | "DONE" | "FAILED" | "ABORTED";

export interface Batch {
  id: string;
  filename: string;
  size_bytes: number;
  status: BatchStatus;
  error: string | null;
  rows_total: number | null;
  rows_valid: number | null;
  rows_rejected: number | null;
  rows_inserted: number | null;
  rows_updated: number | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineEvent {
  stage: string;   // upload | ingest | match | notify | workflow
  status: string;  // started | completed | loaded | failed | ...
  detail: Record<string, unknown>;
  at: string;
}

export interface ErrorRow {
  row: number;
  column: string | null;
  code: string;
  problem: string;
  value_found: string | null;
}

export interface ProductMatchCount {
  lender_name: string;
  product_name: string;
  users: number;
  eligible: number;
  likely: number;
}

export interface BatchSummary {
  users_matched: number;
  emails_sent: number;
  emails_failed: number;
  emails_pending: number;
  by_product: ProductMatchCount[];
}

export interface BatchView {
  batch: Batch;
  timeline: PipelineEvent[];
  errors_preview: ErrorRow[];
  summary: BatchSummary;
  /** Absent from APIs that predate workflow D. */
  confirmations?: Confirmations;
}

/** How the "to confirm" questions went for one upload (workflow D). Answers are self-declared. */
export interface Confirmations {
  asked: number;     // sent emails that carried a question link
  answered: number;  // people who submitted answers
  flagged: number;   // contradictory answers held for ops review, not used
  unlocked: number;  // matches that moved from "to confirm" to eligible on those answers
}

export type BatchListItem = Pick<Batch,
  "id" | "filename" | "status" | "size_bytes" | "rows_total" | "rows_valid" | "rows_rejected" | "created_at" | "updated_at"
> & { rows_inserted: number | null };

/** Treasure Hunt metrics written by workflow B into the match/completed event. */
export interface MatchFunnel {
  users: number;
  products: number;
  classes: number;
  naive_pairs: number;
  after_hard_rules: number;
  needing_soft_rules: number;
  llm_keys: number;
  llm_calls?: number;
  llm_new_judgments?: number;
  llm_cache_hits: number;
  matches: number;
  likely: number;
  new_matches?: number;
  /** Absent for batches matched before questions existed. */
  question_plan?: QuestionPlan;
}

/** Which facts our data can't answer are asked to the person instead (workflow B → C). */
export interface QuestionPlan {
  users_to_ask: number;
  unlockable_matches: number;
  by_question: QuestionPlanItem[];
}

export interface QuestionPlanItem {
  id: string;          // work_experience | employer_type | bank_accounts | city | business_vintage | existing_emi
  label: string;       // plain-English question, as the person sees it
  users: number;       // people this question is asked to
  unlockable: number;  // "to confirm" offers it can unlock
}

export interface Overview {
  active_products: number;
  lenders: number;
  last_crawl_at: string | null;
  users: number;
  matches: number;
  emails_sent: number;
  uploads: number;
}

export interface SoftRule {
  text: string;
  depends_on: string[];
}

export interface LoanProduct {
  id: number;
  lender_name: string;
  product_name: string;
  source_url: string;
  interest_rate_min: number | null;
  interest_rate_max: number | null;
  min_monthly_income: number | null;
  min_credit_score: number | null;
  accepts_ntc: boolean;
  min_age: number | null;
  max_age: number | null;
  employment_types: string[] | null;
  max_loan_amount: number | null;
  soft_rules: SoftRule[];
  evidence: Record<string, string>;
  last_seen_at: string;
  updated_at: string;
}

export interface ColumnSpec {
  name: string;
  required: boolean;
  aliases: string[];
  example: string;
  hint: string;
}

export interface UploadSession {
  batch_id: string;
  part_size: number;
  part_count: number;
  max_parallel: number;
}

export interface PartUrl {
  part_number: number;
  url: string;
  headers: Record<string, string>;
}

export interface UploadedPart {
  part_number: number;
  etag: string;
  size: number;
}
