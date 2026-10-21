// What a batch status means for the person looking at it. Pure: unit-tested, no React.

import type { BatchStatus, MatchFunnel, PipelineEvent } from "./api/types.ts";

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

const EVENT_LABEL: Record<string, string> = {
  "upload/started": "Upload started", "upload/completed": "File stored", "upload/aborted": "Upload cancelled",
  "ingest/started": "Validating rows", "ingest/loaded": "Users saved", "ingest/failed": "File rejected",
  "ingest/matching_triggered": "Matching triggered", "ingest/awaiting_sweeper": "Queued for matching",
  "match/started": "Matching started", "match/completed": "Matches saved",
  "notify/started": "Sending emails", "notify/completed": "Emails finished", "workflow/failed": "A workflow step failed",
};

export const eventLabel = (e: PipelineEvent) => EVENT_LABEL[`${e.stage}/${e.status}`] ?? `${e.stage}: ${e.status}`;
