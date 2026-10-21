import styles from "./ConsoleMockup.module.css";

const BARS = [
  { label: "Every person × loan", value: 40000, pct: 100 },
  { label: "Pass hard rules", value: 12930, pct: 74 },
  { label: "Asked the AI", value: 0, pct: 0 },
  { label: "Matches", value: 12930, pct: 74 },
];

/** Illustration only: sample data, clearly labelled. Shows the upload → match → email story at a glance. */
export function ConsoleMockup() {
  return (
    <div className={styles.panel}>
      <div className={styles.window} aria-label="Example of the Loan Match console and the email a borrower receives">
        <div className={styles.titlebar}>
          <div className={styles.lights} aria-hidden><i /><i /><i /></div>
          <span className={styles.url}>loan-match · demo</span>
          <span className={styles.demo}>Demo data</span>
        </div>
        <div className={styles.body}>
          <div className={styles.left}>
            <div className={styles.file}><b>october-leads.csv</b><span className="pill pill-run">Sending emails</span></div>
            <div className={styles.steps}>
              <div className={`${styles.step} ${styles.done}`}><b>Uploaded</b>1.0 MB</div>
              <div className={`${styles.step} ${styles.done}`}><b>Validated</b>10,000 rows</div>
              <div className={`${styles.step} ${styles.done}`}><b>Matched</b>229 profiles</div>
              <div className={`${styles.step} ${styles.now}`}><b>Emailing</b>in progress</div>
            </div>
            <div className={styles.bars}>
              {BARS.map((b) => (
                <div key={b.label} className={styles.bar}>
                  <span>{b.label}</span>
                  <span className={styles.track}><span style={{ width: `${b.pct}%` }} /></span>
                  <span className={styles.num}>{b.value.toLocaleString("en-IN")}</span>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.right}>
            <div className={styles.mailHead}>To: priya+one@gmail.com</div>
            <div className={styles.subject}>Priya, 3 personal loans you may qualify for</div>
            <div className={styles.offer}>
              <span className={styles.lender}>HDFC Bank</span>
              <b>Personal Loan · from 9.99% p.a.</b>
              <div className={styles.why}>✓ income ₹62,000/month ≥ ₹25,000</div>
            </div>
            <div className={styles.offer}>
              <span className={styles.lender}>Kotak Mahindra Bank</span>
              <b>Personal Loan · from 10.99% p.a.</b>
              <div className={styles.why}>✓ credit score 760 ≥ 750</div>
              <div className={styles.todo}>? To confirm: 1 year of work experience</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
