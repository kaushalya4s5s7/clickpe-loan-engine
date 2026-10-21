"use client";

import type { ColumnSpec } from "@/lib/api/types.ts";
import { templateCsv } from "@/lib/csv/inspect.ts";
import { Icon, Skeleton } from "../ui";
import styles from "./upload.module.css";

function downloadTemplate(columns: ColumnSpec[]) {
  const url = URL.createObjectURL(new Blob(["﻿" + templateCsv(columns)], { type: "text/csv;charset=utf-8" }));
  Object.assign(document.createElement("a"), { href: url, download: "loan-match-template.csv" }).click();
  URL.revokeObjectURL(url);
}

/** The accepted format, straight from the server's schema (the same table the server validates with). */
export function FormatGuide({ columns }: { columns: ColumnSpec[] | null }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>File format</h2>
        <button className="btn btn-ghost btn-sm" disabled={!columns} onClick={() => columns && downloadTemplate(columns)}>
          <Icon name="download" size={15} /> Template
        </button>
      </div>
      <div className="card-pad">
        {!columns ? (
          <div className="stack"><Skeleton /><Skeleton /><Skeleton width="70%" /></div>
        ) : (
          <dl className={styles.guide}>
            {columns.map((c) => (
              <div key={c.name}>
                <dt><code>{c.name}</code> {c.required ? <span className="chip">required</span> : <span className="muted small">optional</span>}</dt>
                <dd>{c.hint}<span className="muted"> Also accepted: {c.aliases.filter((a) => a !== c.name).slice(0, 3).join(", ")}.</span></dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
