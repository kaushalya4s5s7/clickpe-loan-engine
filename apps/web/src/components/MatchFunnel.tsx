// The Optimization Treasure Hunt, made visible: how much work each stage removed.
// Bars use a log scale — the stages differ by orders of magnitude.

import type { MatchFunnel as Funnel } from "@/lib/api/types.ts";
import { num } from "@/lib/format.ts";
import { matchesNote } from "@/lib/pipeline.ts";
import styles from "./MatchFunnel.module.css";

const width = (value: number, max: number) => (value <= 0 ? 0 : Math.max(1.5, (100 * Math.log10(value + 1)) / Math.log10(max + 1)));

export function MatchFunnel({ funnel }: { funnel: Funnel }) {
  const max = Math.max(1, funnel.naive_pairs);
  const llmCalls = funnel.llm_calls ?? 0;
  const rows = [
    { name: "Every person × every loan", note: "what a naive system would evaluate", value: funnel.naive_pairs, kind: "" },
    { name: "Pass the hard rules", note: "income, credit score, age, employment", value: funnel.after_hard_rules, kind: "" },
    { name: "Have a qualitative condition", note: "e.g. work experience, employer type", value: funnel.needing_soft_rules, kind: "" },
    // llm_keys is measured after the AI answered (always 0 then); llm_new_judgments is what was actually asked.
    { name: "Questions sent to the AI", note: `answers reused for ${num(funnel.llm_cache_hits)} checks`,
      value: funnel.llm_new_judgments ?? funnel.llm_keys, kind: "ai" },
    { name: "Matches", note: matchesNote(funnel), value: funnel.matches, kind: "final" },
  ];
  return (
    <div>
      <div className={styles.rows}>
        {rows.map((r) => (
          <div key={r.name} className={styles.row}>
            <div className={styles.name}>{r.name}<small>{r.note}</small></div>
            <div className={styles.track}>
              <div className={`${styles.fill} ${r.kind ? styles[r.kind] : ""}`} style={{ width: `${width(r.value, max)}%` }} />
            </div>
            <div className={styles.value}>{num(r.value)}</div>
          </div>
        ))}
      </div>
      <div className={styles.callout}>
        <div className={styles.box}><b>{num(funnel.users)} → {num(funnel.classes)}</b>people grouped into profiles that every lender treats identically</div>
        <div className={styles.box}><b>{num(llmCalls)} AI call{llmCalls === 1 ? "" : "s"}</b>instead of {num(funnel.naive_pairs)} if the AI checked every pair</div>
        <div className={styles.box}><b>{num(funnel.products)} loan products</b>checked for every person in this upload</div>
      </div>
    </div>
  );
}
