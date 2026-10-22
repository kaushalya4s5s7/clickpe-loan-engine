// "To confirm" matches, turned into questions: a lender condition our data can't answer (work
// experience, employer type, an existing account...) is asked to the person, never guessed.

import { Stat } from "../ui";
import styles from "./batch.module.css";
import type { Confirmations, QuestionPlan as Plan } from "@/lib/api/types.ts";
import { num } from "@/lib/format.ts";

export function QuestionPlan({ plan, confirmations }: { plan: Plan; confirmations?: Confirmations }) {
  const max = Math.max(1, ...plan.by_question.map((q) => q.unlockable));
  return (
    <section className="card">
      <div className="card-head">
        <h2>Questions we ask instead of guessing</h2>
        <span className="muted small">up to 3 per person, in their email</span>
      </div>
      <div className="card-pad stack">
        <p className="small" style={{ color: "var(--text-2)" }}>
          When a lender condition depends on something our data can&apos;t answer, we ask the person rather than guess.
          Their answers are self-declared — the lender still verifies documents when they apply.
        </p>
        <div className="stats">
          <Stat label="People to ask" value={num(plan.users_to_ask)} />
          <Stat label="Offers the answers can unlock" value={num(plan.unlockable_matches)} note="currently “to confirm”" />
        </div>
        {plan.by_question.length > 0 && (
          <div className="table-wrap" style={{ border: "1px solid var(--line)", borderRadius: 10 }}>
            <table className="table">
              <thead><tr><th>Question</th><th className="num">People asked</th><th className="num">Offers it can unlock</th></tr></thead>
              <tbody>
                {plan.by_question.map((q) => (
                  <tr key={q.id}>
                    <td>{q.label}<div className={styles.bar}><span style={{ width: `${(100 * q.unlockable) / max}%` }} /></div></td>
                    <td className="num">{num(q.users)}</td>
                    <td className="num">{num(q.unlockable)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {confirmations && (
          <>
            <h3 className={styles.subhead}>Answers so far</h3>
            <div className={styles.confirmations}>
              <Stat label="Asked" value={num(confirmations.asked)} note="emails with questions" />
              <Stat label="Answered" value={num(confirmations.answered)} />
              <Stat label="Flagged for review" value={num(confirmations.flagged)} tone={confirmations.flagged ? "bad" : undefined}
                    note="contradictory, not used" />
              <Stat label="Offers unlocked" value={num(confirmations.unlocked)} tone={confirmations.unlocked ? "ok" : undefined}
                    note="now pre-qualified" />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
