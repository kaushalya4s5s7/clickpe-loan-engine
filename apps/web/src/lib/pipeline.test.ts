import assert from "node:assert/strict";
import test from "node:test";
import type { MatchFunnel } from "./api/types.ts";
import { funnelOf, matchesNote, questionPlanOf, steps } from "./pipeline.ts";

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

test("matches note splits eligible and to confirm", () => {
  assert.equal(matchesNote({ matches: 60000, likely: 56963 }), "3,037 eligible · 56,963 to confirm");
  assert.equal(matchesNote({ matches: 4, likely: 0 }), "4 eligible · 0 to confirm");
});

test("question plan is optional and tolerant of old or malformed events", () => {
  const funnel = (extra: Record<string, unknown>) => ({ matches: 1, likely: 1, ...extra }) as unknown as MatchFunnel;
  assert.equal(questionPlanOf(null), null);
  assert.equal(questionPlanOf(funnel({})), null);
  assert.equal(questionPlanOf(funnel({ question_plan: { users_to_ask: 3 } })), null);
  const plan = questionPlanOf(funnel({ question_plan: { users_to_ask: 120, unlockable_matches: 300, by_question: [
    { id: "city", label: "Which city do you live in?", users: 40, unlockable: 50 },
    { id: "work_experience", label: "How long have you been working?", users: 90, unlockable: 250 },
    { id: "employer_type", users: "x", unlockable: null },
    null,
  ] } }));
  assert.equal(plan?.users_to_ask, 120);
  assert.equal(plan?.unlockable_matches, 300);
  assert.deepEqual(plan?.by_question.map((q) => q.id), ["work_experience", "city", "employer_type"]);
  assert.deepEqual(plan?.by_question[2], { id: "employer_type", label: "employer_type", users: 0, unlockable: 0 });
});
