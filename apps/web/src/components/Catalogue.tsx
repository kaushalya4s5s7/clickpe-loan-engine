"use client";

import { useMemo } from "react";
import { useApi } from "./ApiProvider";
import styles from "./catalogue.module.css";
import { EmptyState, ErrorNote, Icon, Skeleton } from "./ui";
import { useLoad } from "@/hooks/useLoad";
import type { LoanProduct } from "@/lib/api/types.ts";
import { inr, inrShort, rateRange, relativeTime } from "@/lib/format.ts";

const FIELD_LABEL: Record<string, string> = {
  interest_rate: "Interest rate", min_monthly_income: "Minimum income", min_credit_score: "Credit score",
  age: "Age", max_loan_amount: "Maximum amount", max_tenure_months: "Tenure",
};

export function Catalogue() {
  const { hasKey, requestKey } = useApi();
  const { data, error, loading, reload } = useLoad((api) => api.products(), [], hasKey);
  const byLender = useMemo(() => {
    const groups = new Map<string, LoanProduct[]>();
    for (const p of data ?? []) groups.set(p.lender_name, [...(groups.get(p.lender_name) ?? []), p]);
    return [...groups.entries()];
  }, [data]);

  if (!hasKey) return <div className="card"><EmptyState title="Connect to see the catalogue" action={<button className="btn" onClick={requestKey}>Add API key</button>} /></div>;
  if (error) return <ErrorNote message={error.message} onRetry={reload} />;
  if (loading || !data) return <div className="grid-2"><Skeleton height={260} /><Skeleton height={260} /></div>;
  if (!data.length) {
    return (
      <div className="card">
        <EmptyState title="No loan products yet">
          The crawler runs daily at 02:00 IST. To fill the catalogue now, open n8n and run
          “A · Discover loan products” → <em>Run now</em>.
        </EmptyState>
      </div>
    );
  }

  return (
    <div>
      {byLender.map(([lender, products]) => (
        <section key={lender} className={styles.lender}>
          <h2>{lender} <span className="chip">{products.length} product{products.length > 1 ? "s" : ""}</span></h2>
          <div className={styles.grid}>{products.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        </section>
      ))}
    </div>
  );
}

function ProductCard({ p }: { p: LoanProduct }) {
  const age = p.min_age !== null || p.max_age !== null ? `${p.min_age ?? "–"}–${p.max_age ?? "–"} yrs` : "Not stated";
  const quotes = Object.entries(p.evidence ?? {});
  return (
    <article className={`card ${styles.product}`}>
      <div>
        <div className={styles.name}>{p.product_name}</div>
        <div className={styles.rate}>{rateRange(p.interest_rate_min, p.interest_rate_max)}</div>
      </div>
      <dl className={styles.criteria}>
        <div><dt>Min. income</dt><dd>{p.min_monthly_income !== null ? `${inr(p.min_monthly_income)}/mo` : "Not stated"}</dd></div>
        <div><dt>Credit score</dt><dd>{p.min_credit_score !== null ? `${p.min_credit_score}+` : "Not stated"}</dd></div>
        <div><dt>Age</dt><dd>{age}</dd></div>
        <div><dt>Up to</dt><dd>{p.max_loan_amount !== null ? inrShort(p.max_loan_amount) : "Not stated"}</dd></div>
      </dl>
      <div className={styles.chips}>
        {(p.employment_types ?? ["Any employment"]).map((e) => <span key={e} className="chip">{e}</span>)}
        {p.accepts_ntc && <span className="chip">No credit history OK</span>}
      </div>
      {p.soft_rules.length > 0 && (
        <div>
          <div className="label">Lender also asks for</div>
          <ul className={styles.rules}>{p.soft_rules.map((r) => <li key={r.text}>{r.text}</li>)}</ul>
        </div>
      )}
      {quotes.length > 0 && (
        <details className={styles.evidence}>
          <summary>Where we read this ({quotes.length} quote{quotes.length > 1 ? "s" : ""})</summary>
          {quotes.map(([field, quote]) => (
            <blockquote key={field}><b>{FIELD_LABEL[field] ?? field}:</b> “{quote}”</blockquote>
          ))}
        </details>
      )}
      <div className={styles.foot}>
        <span><Icon name="clock" size={13} /> checked {relativeTime(p.last_seen_at)}</span>
        <a href={p.source_url} target="_blank" rel="noopener noreferrer">Lender page ↗</a>
      </div>
    </article>
  );
}
