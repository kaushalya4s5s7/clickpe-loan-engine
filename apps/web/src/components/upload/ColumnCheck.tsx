import type { Inspection } from "@/lib/csv/inspect.ts";
import { num } from "@/lib/format.ts";
import { Icon } from "../ui";
import styles from "./upload.module.css";

const DELIMITER_NAME: Record<string, string> = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" };

/** Which required columns we found (and under what heading), plus the first rows as we read them. */
export function ColumnCheck({ inspection }: { inspection: Inspection }) {
  const i = inspection;
  return (
    <div className="stack">
      <div className={styles.facts}>
        <span><b>{i.encoding}</b> encoding</span>
        <span><b>{DELIMITER_NAME[i.delimiter] ?? i.delimiter}</b>-separated</span>
        <span>header on row <b>{i.headerRowNumber}</b></span>
        <span>about <b>{num(i.estimatedRows)}</b> rows</span>
      </div>
      <ul className={styles.columns}>
        {i.matches.map((m) => (
          <li key={m.column} className={m.header ? styles.found : m.required ? styles.missing : styles.optional}>
            <span className={styles.colIcon}>{m.header ? <Icon name="check" size={14} /> : m.required ? <Icon name="x" size={14} /> : "–"}</span>
            <span className={styles.colName}><code>{m.column}</code>{!m.required && <span className="muted small"> optional</span>}</span>
            <span className={`${styles.colFound} muted small`}>
              {m.header ? (m.header === m.column ? "found" : <>found as “{m.header}”</>) : m.required ? "not found" : "not included"}
            </span>
          </li>
        ))}
      </ul>
      {i.previewRows.length > 0 && (
        <div>
          <div className="label">First rows, as we read them</div>
          <div className={`table-wrap ${styles.preview}`}>
            <table className="table">
              <thead><tr>{i.previewHeader.map((h, k) => <th key={k}>{h || <span className="muted">(blank)</span>}</th>)}</tr></thead>
              <tbody>
                {i.previewRows.map((r, k) => (
                  <tr key={k}>{i.previewHeader.map((_, c) => <td key={c}>{r[c] ?? ""}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
