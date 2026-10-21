// Small presentational primitives. No data fetching here — pages pass data in.

import type { ReactNode } from "react";
import type { BatchStatus } from "@/lib/api/types.ts";
import { STATUS_LABEL, statusTone } from "@/lib/pipeline.ts";

export function StatusPill({ status }: { status: BatchStatus }) {
  return <span className={`pill pill-${statusTone(status)}`}>{STATUS_LABEL[status]}</span>;
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "ok" | "bad" }) {
  return (
    <div className={`stat${tone ? ` tone-${tone}` : ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ title = "Something went wrong", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div className="alert alert-bad" role="alert">
      <div>
        <strong>{title}</strong>
        {message}
        {onRetry ? (
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden />;
}

export function Icon({ name, size = 18 }: { name: "upload" | "check" | "shield" | "spark" | "mail" | "file" | "x" | "download" | "arrow" | "clock"; size?: number }) {
  const paths: Record<string, ReactNode> = {
    upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>,
    check: <path d="m5 12 5 5L20 7" />,
    shield: <><path d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></>,
    spark: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="m6 6 2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
    file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></>,
    x: <path d="M6 6l12 12M18 6 6 18" />,
    download: <><path d="M12 4v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></>,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      {paths[name]}
    </svg>
  );
}
