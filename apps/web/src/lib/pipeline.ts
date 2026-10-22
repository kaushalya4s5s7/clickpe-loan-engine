// What a batch status means for the person looking at it. Pure: unit-tested, no React.

import { num } from "./format.ts";
import type { BatchStatus, MatchFunnel, PipelineEvent, QuestionPlan } from "./api/types.ts";

export type StepState = "done" | "active" | "failed" | "todo";

export interface Step {
  key: "upload" | "validate" | "match" | "notify";
  label: string;
  hint: string;
  state: StepState;
}

const ORDER: Step["key"][] = ["upload", "validate", "match", "notify"];
const LABELS: Record<Step["key"], [string, string]> = {
  upload: ["Uploaded", "File stored securely"],
  validate: ["Validated", "Rows checked and saved"],
  match: ["Matched", "Checked against lender rules"],
  notify: ["Emailed", "Personalised offers sent"],
};

/** Index of the step currently in progress (ORDER.length = everything finished). */
const PROGRESS: Record<BatchStatus, number> = {
  CREATED: 0, UPLOADED: 1, PARSING: 1, LOADED: 2, MATCHING: 2, MATCHED: 3, NOTIFYING: 3, DONE: 4, FAILED: -1, ABORTED: -1,
};

export const TERMINAL: ReadonlySet<BatchStatus> = new Set(["DONE", "FAILED", "ABORTED"]);

export function steps(status: BatchStatus, timeline: PipelineEvent[] = []): Step[] {
  let current = PROGRESS[status];
  let failed = false;
  if (current < 0) {
    // Failed: the failing step is the last stage that logged something.
    failed = true;
    const last = [...timeline].reverse().find((e) => e.stage !== "workflow")?.stage ?? "upload";
    const stageToStep: Record<string, Step["key"]> = { upload: "upload", ingest: "validate", match: "match", notify: "notify" };
    current = ORDER.indexOf(stageToStep[last] ?? "upload");
  }
  return ORDER.map((key, i) => ({
    key,
    label: LABELS[key][0],
    hint: LABELS[key][1],
    state: i < current ? "done" : i === current ? (failed ? "failed" : "active") : "todo",
  }));
}

export function statusTone(status: BatchStatus): "ok" | "bad" | "run" | "idle" {
  if (status === "DONE") return "ok";
  if (status === "FAILED" || status === "ABORTED") return "bad";
  if (status === "CREATED") return "idle";
  return "run";
}

export const STATUS_LABEL: Record<BatchStatus, string> = {
  CREATED: "Uploading", UPLOADED: "Queued", PARSING: "Validating", LOADED: "Waiting to match", MATCHING: "Matching",
  MATCHED: "Preparing emails", NOTIFYING: "Sending emails", DONE: "Complete", FAILED: "Failed", ABORTED: "Cancelled",
};

/** The Treasure Hunt metrics, if workflow B has finished. */
export function funnelOf(timeline: PipelineEvent[]): MatchFunnel | null {
  const event = [...timeline].reverse().find((e) => e.stage === "match" && e.status === "completed");
  return event ? (event.detail as unknown as MatchFunnel) : null;
}

/** "Matches" splits into eligible now and to confirm (a lender condition our data can't answer). */
export function matchesNote(funnel: Pick<MatchFunnel, "matches" | "likely">): string {
  const likely = funnel.likely ?? 0;
  return `${num(Math.max(0, funnel.matches - likely))} eligible · ${num(likely)} to confirm`;
}

/**
 * The question plan, if the match event carried a usable one. The event detail is free-form JSON,
 * so anything malformed is treated as absent; questions are ordered by offers they can unlock.
 */
export function questionPlanOf(funnel: MatchFunnel | null): QuestionPlan | null {
  const plan = funnel?.question_plan as Partial<QuestionPlan> | undefined | null;
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.by_question)) return null;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const byQuestion = plan.by_question
    .filter((q) => q && typeof q === "object" && typeof q.id === "string")
    .map((q) => ({ id: q.id, label: typeof q.label === "string" && q.label ? q.label : q.id, users: count(q.users), unlockable: count(q.unlockable) }))
    .sort((a, b) => b.unlockable - a.unlockable || b.users - a.users);
  return { users_to_ask: count(plan.users_to_ask), unlockable_matches: count(plan.unlockable_matches), by_question: byQuestion };
}

const EVENT_LABEL: Record<string, string> = {
  "upload/started": "Upload started", "upload/completed": "File stored", "upload/aborted": "Upload cancelled",
  "ingest/started": "Validating rows", "ingest/loaded": "Users saved", "ingest/failed": "File rejected",
  "ingest/matching_triggered": "Matching triggered", "ingest/awaiting_sweeper": "Queued for matching",
  "match/started": "Matching started", "match/completed": "Matches saved",
  "notify/started": "Sending emails", "notify/completed": "Emails finished", "workflow/failed": "A workflow step failed",
};

export const eventLabel = (e: PipelineEvent) => EVENT_LABEL[`${e.stage}/${e.status}`] ?? `${e.stage}: ${e.status}`;
