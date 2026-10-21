"use client";

import { useLoad } from "@/hooks/useLoad";
import { num, relativeTime } from "@/lib/format.ts";
import styles from "@/app/landing.module.css";

/** Live numbers from GET /v1/overview (public aggregates). Hidden entirely if the API is unreachable. */
export function LiveStats() {
  const { data, error } = useLoad((api) => api.overview());
  if (error) return null;
  const cells = [
    { value: data ? num(data.lenders) : "—", label: data ? `Lenders · checked ${relativeTime(data.last_crawl_at)}` : "Lenders tracked" },
    { value: data ? num(data.active_products) : "—", label: "Loan products" },
    { value: data ? num(data.users) : "—", label: "People processed" },
    { value: data ? num(data.matches) : "—", label: "Matches found" },
    { value: data ? num(data.emails_sent) : "—", label: "Offer emails sent" },
  ];
  return (
    <div className={styles.stats} aria-busy={!data}>
      {cells.map((c) => (
        <div key={c.label}><div className={styles.statValue}>{c.value}</div><div className={styles.statLabel}>{c.label}</div></div>
      ))}
    </div>
  );
}
