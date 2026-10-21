import type { Step } from "@/lib/pipeline.ts";
import { Icon } from "./ui";
import styles from "./PipelineStepper.module.css";

export function PipelineStepper({ steps }: { steps: Step[] }) {
  return (
    <ol className={styles.steps} aria-label="Pipeline progress">
      {steps.map((s, i) => (
        <li key={s.key} className={`${styles.step} ${styles[s.state] ?? ""}`} aria-current={s.state === "active" ? "step" : undefined}>
          <span className={styles.dot}>
            {s.state === "done" ? <Icon name="check" size={14} /> : s.state === "failed" ? <Icon name="x" size={14} />
              : s.state === "active" ? <span className="spin" /> : i + 1}
          </span>
          <div className={styles.label}>{s.label}</div>
          <div className={styles.hint}>{s.state === "failed" ? "Stopped here" : s.hint}</div>
        </li>
      ))}
    </ol>
  );
}
