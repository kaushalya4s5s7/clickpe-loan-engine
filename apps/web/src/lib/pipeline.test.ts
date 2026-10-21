import assert from "node:assert/strict";
import test from "node:test";
import { funnelOf, steps } from "./pipeline.ts";

const states = (s: ReturnType<typeof steps>) => s.map((x) => x.state).join(",");

test("progress through the pipeline", () => {
  assert.equal(states(steps("CREATED")), "active,todo,todo,todo");
  assert.equal(states(steps("PARSING")), "done,active,todo,todo");
  assert.equal(states(steps("MATCHING")), "done,done,active,todo");
  assert.equal(states(steps("DONE")), "done,done,done,done");
});

test("a failure is shown on the step that failed", () => {
  const timeline = [
    { stage: "upload", status: "completed", detail: {}, at: "" },
    { stage: "ingest", status: "failed", detail: {}, at: "" },
  ];
  assert.equal(states(steps("FAILED", timeline)), "done,failed,todo,todo");
});

test("funnel comes from the match/completed event", () => {
  assert.equal(funnelOf([]), null);
  const f = funnelOf([{ stage: "match", status: "completed", detail: { users: 5, matches: 6 }, at: "" }]);
  assert.equal(f?.matches, 6);
});
