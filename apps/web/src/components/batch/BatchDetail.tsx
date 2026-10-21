"use client";

// One upload, end to end: pipeline progress, validation results, the matching funnel, matches per
// lender product and the email outcome. Polls until the pipeline finishes.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApi } from "../ApiProvider";
import { MatchFunnel } from "../MatchFunnel";
import { PipelineStepper } from "../PipelineStepper";
import { EmptyState, ErrorNote, Icon, Skeleton, Stat, StatusPill } from "../ui";
import styles from "./batch.module.css";
import { usePolling } from "@/hooks/usePolling";
import type { BatchView } from "@/lib/api/types.ts";
import { bytes, num, percent, relativeTime } from "@/lib/format.ts";
import { eventLabel, funnelOf, steps, TERMINAL } from "@/lib/pipeline.ts";

export function BatchDetail() {
  const id = useSearchParams()?.get("id") ?? null;
  const { data, error } = usePolling<BatchView>((api) => api.batch(id!), (v) => TERMINAL.has(v.batch.status), id);

  if (!id) return <EmptyState title="No upload selected" action={<Link href="/history/" className="btn">See all uploads</Link>} />;
  if (error?.status === 404) return <EmptyState title="Upload not found">This link may be wrong or the upload was removed.</EmptyState>;
  if (!data) {
    return error ? <ErrorNote message={error.message} /> : (
      <div className="stack"><Skeleton height={36} width="50%" /><Skeleton height={64} /><Skeleton height={120} /></div>
    );
  }

  const { batch, timeline, errors_preview: errors, summary } = data;
  const funnel = funnelOf(timeline);
  const finished = TERMINAL.has(batch.status);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Upload</span>
          <h1>{batch.filename}</h1>
          <div className={styles.meta}>
            <span><code>{batch.id}</code></span>
            <span>{bytes(batch.size_bytes)}</span>
            <span>uploaded {relativeTime(batch.created_at)}</span>
          </div>
        </div>
        <div className="row">
          <StatusPill status={batch.status} />
          {!finished && <span className="muted small" aria-live="polite">updating live…</span>}
        </div>
      </div>

      <PipelineStepper steps={steps(batch.status, timeline)} />

      {batch.status === "FAILED" && batch.error && (
        <div className="alert alert-bad" role="alert">
          <div>
            <strong>{batch.error.split(":")[0] === "TOO_MANY_INVALID_ROWS" ? "Too many rows have problems — nothing was saved" : "This upload couldn't be processed"}</strong>
            {batch.error.replace(/^[A-Z_]+:\s*/, "")}
            <div className="row" style={{ marginTop: 10 }}>
              <ReportButton batchId={batch.id} />
              <Link href="/upload/" className="btn btn-sm">Upload a fixed file</Link>
            </div>
          </div>
        </div>
      )}

      {batch.rows_total !== null && (
        <section className="card">
          <div className="card-head"><h2>Validation</h2>{(batch.rows_rejected ?? 0) > 0 && <ReportButton batchId={batch.id} />}</div>
          <div className="card-pad stack">
            <div className="stats">
              <Stat label="Rows read" value={num(batch.rows_total)} />
              <Stat label="Valid" value={num(batch.rows_valid)} tone="ok" note={percent(batch.rows_valid ?? 0, batch.rows_total ?? 0)} />
              <Stat label="Skipped (problems)" value={num(batch.rows_rejected)} tone={(batch.rows_rejected ?? 0) > 0 ? "bad" : undefined} />
              <Stat label="New people" value={num(batch.rows_inserted)} />
              <Stat label="Updated people" value={num(batch.rows_updated)} note="unchanged rows are left alone" />
            </div>
            {errors.length > 0 && (
              <div className="table-wrap" style={{ border: "1px solid var(--line)", borderRadius: 10 }}>
                <table className="table">
                  <thead><tr><th className="num">Row</th><th>Column</th><th>Problem</th><th>Value found</th></tr></thead>
                  <tbody>
                    {errors.map((e, k) => (
                      <tr key={k}>
                        <td className="num">{e.row}</td>
                        <td><code>{e.column ?? "—"}</code></td>
                        <td>{e.problem}</td>
                        <td className="muted">{e.value_found || "(empty)"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {errors.length >= 8 && <p className="muted small">Showing the first {errors.length}. The full report lists every row.</p>}
          </div>
        </section>
      )}

      {funnel && (
        <section className="card">
          <div className="card-head">
            <h2>How matching narrowed things down</h2>
            <span className="muted small">rules first, AI only where needed</span>
          </div>
          <div className="card-pad"><MatchFunnel funnel={funnel} /></div>
        </section>
      )}

      {summary.by_product.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Matches by loan product</h2>
            <span className="muted small">{num(summary.users_matched)} people matched at least one loan</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Lender</th><th>Product</th><th className="num">People</th><th className="num">Eligible</th><th className="num">To confirm</th></tr></thead>
              <tbody>
                {summary.by_product.map((p) => {
                  const max = summary.by_product[0]?.users ?? 1;
                  return (
                    <tr key={`${p.lender_name}/${p.product_name}`}>
                      <td>{p.lender_name}</td>
                      <td>{p.product_name}<div className={styles.bar}><span style={{ width: `${(100 * p.users) / max}%` }} /></div></td>
                      <td className="num">{num(p.users)}</td>
                      <td className="num">{num(p.eligible)}</td>
                      <td className="num">{num(p.likely)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(summary.emails_sent + summary.emails_failed + summary.emails_pending > 0 || batch.status === "DONE") && (
        <section className="card">
          <div className="card-head"><h2>Emails</h2><Icon name="mail" /></div>
          <div className="card-pad stack">
            <div className={styles.emails}>
              <Stat label="Sent" value={num(summary.emails_sent)} tone="ok" />
              <Stat label="Waiting" value={num(summary.emails_pending)} />
              <Stat label="Failed" value={num(summary.emails_failed)} tone={summary.emails_failed ? "bad" : undefined} />
            </div>
            <p className="muted small">
              Only people with new matches are emailed, at most once a week, and never twice for the same offer. In test mode,
              emails go to your test inboxes instead of the addresses in the file.
            </p>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head"><h2>Activity</h2></div>
        <div className="card-pad">
          <ol className={styles.timeline}>
            {timeline.map((e, k) => (
              <li key={k} className={e.status === "failed" ? styles.failed : undefined}>
                <span className={styles.time}>{new Date(e.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                <span>{eventLabel(e)}{typeof e.detail?.message === "string" ? ` — ${e.detail.message}` : ""}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}

function ReportButton({ batchId }: { batchId: string }) {
  const { api } = useApi();
  const download = async () => {
    const url = URL.createObjectURL(await api.errorsCsv(batchId));
    Object.assign(document.createElement("a"), { href: url, download: `errors-${batchId.slice(0, 8)}.csv` }).click();
    URL.revokeObjectURL(url);
  };
  return <button className="btn btn-secondary btn-sm" onClick={download}><Icon name="download" size={15} /> Error report</button>;
}
