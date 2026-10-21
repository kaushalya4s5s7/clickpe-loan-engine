"use client";

import { useRouter } from "next/navigation";
import type { BatchListItem } from "@/lib/api/types.ts";
import { num, relativeTime } from "@/lib/format.ts";
import { StatusPill } from "./ui";

export function BatchTable({ batches }: { batches: BatchListItem[] }) {
  const router = useRouter();
  const open = (id: string) => router.push(`/batch/?id=${encodeURIComponent(id)}`);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>File</th><th>Uploaded</th><th className="num">Rows</th><th className="num">Valid</th><th className="num">Rejected</th><th>Status</th></tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} className="clickable" onClick={() => open(b.id)}>
              <td>
                {/* a real link too: keyboard users and "open in new tab" */}
                <a href={`/batch/?id=${encodeURIComponent(b.id)}`} onClick={(e) => { e.preventDefault(); open(b.id); }}>{b.filename}</a>
                <div className="muted small"><code>{b.id.slice(0, 8)}</code></div>
              </td>
              <td className="muted">{relativeTime(b.created_at)}</td>
              <td className="num">{num(b.rows_total)}</td>
              <td className="num">{num(b.rows_valid)}</td>
              <td className="num">{num(b.rows_rejected)}</td>
              <td><StatusPill status={b.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
