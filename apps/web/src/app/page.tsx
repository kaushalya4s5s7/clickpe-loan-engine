import Link from "next/link";
import { ConsoleMockup } from "@/components/landing/ConsoleMockup";
import { LiveStats } from "@/components/landing/LiveStats";
import { RecentUploads } from "@/components/landing/RecentUploads";
import styles from "./landing.module.css";

const STEPS = [
  { title: "Upload a lead list", text: "A CSV from Excel or Google Sheets. We check your columns before anything is uploaded." },
  { title: "We clean every row", text: "₹1,20,000, 1.2L and 'NA' credit scores are understood. Bad rows come back with their row number." },
  { title: "Matched to lender rules", text: "Criteria are read daily from lenders' own websites. Rules decide first; AI only reads what rules can't." },
  { title: "Each person gets their options", text: "One personal email with the loans they may get and exactly why. Never twice for the same offer." },
];

const FOR_TEAM = [
  ["Resumable uploads", "Large files go up in parts and continue where they stopped."],
  ["Checked before upload", "Missing columns are caught in the browser, using the server's own rules."],
  ["A fix-it report", "Every skipped row, its row number and what to change — opens cleanly in Excel."],
  ["Live progress", "Watch validation, matching and emails happen, with the numbers behind each step."],
  ["Always-fresh catalogue", "Lender pages re-read daily; a broken page never wipes yesterday's data."],
];

const FOR_BORROWERS = [
  ["Only loans they may get", "Income, credit score, age and employment checked against published criteria."],
  ["The reason, in their numbers", "“Your income ₹62,000 ≥ ₹25,000 minimum” — not a generic pitch."],
  ["Honest about unknowns", "Conditions we can't check, like work experience, are listed to confirm."],
  ["No spam", "At most one email a week, never the same offer twice, one-click unsubscribe."],
];

export default function Home() {
  return (
    <>
      <section className={`container ${styles.hero}`}>
        <h1 className={styles.title}>Every lead, matched to a loan they can actually get.</h1>
        <p className={styles.lead}>
          Upload your users. We check each person against live criteria from lenders&apos; own websites, then email them
          the personal loans they&apos;re likely to qualify for — with the reasons.
        </p>
        <div className={styles.ctas}>
          <Link href="/upload/" className="btn btn-lg">Upload a lead list</Link>
          <Link href="/catalogue/" className="btn btn-lg btn-secondary">See the loan catalogue</Link>
        </div>
        <ConsoleMockup />
      </section>

      <LiveStats />

      <section className={styles.section} style={{ borderTop: 0 }}>
        <div className="container">
        <div className={styles.head}>
          <div><span className="label-chip">How it works</span><h2>From spreadsheet to inbox, on its own.</h2></div>
          <p>You upload once. Validation, matching and the emails run automatically, and every step is visible as it happens.</p>
        </div>
        <div className={styles.steps}>
          {STEPS.map((s, i) => (
            <div key={s.title} className={styles.step}>
              <div className={styles.stepTop}><span className="grid-mark" aria-hidden /><span className={styles.stepNum}>0{i + 1}</span></div>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className="container">
          <div className={styles.head}>
            <div><span className="label-chip">Built for both sides</span><h2>Clear for your team. Fair to borrowers.</h2></div>
            <p>Designed around what goes wrong in real operations: messy spreadsheets, dropped connections, and inboxes full of irrelevant offers.</p>
          </div>
          <div className={styles.cards}>
            <div className={`card card-blue ${styles.card}`}>
              <span className={`${styles.tag} ${styles.tagBlue}`}>Operations</span>
              <h3>For your team</h3>
              <p>Upload, watch, fix, done.</p>
              <ul className="checklist">{FOR_TEAM.map(([t, d]) => <li key={t}><b>{t}</b> — {d}</li>)}</ul>
              <Link href="/upload/" className="btn" style={{ marginTop: 8 }}>Start an upload</Link>
            </div>
            <div className={`card card-gray ${styles.card}`}>
              <span className={`${styles.tag} ${styles.tagGray}`}>Borrowers</span>
              <h3>For the people on your list</h3>
              <p>One email they can trust.</p>
              <ul className="checklist">{FOR_BORROWERS.map(([t, d]) => <li key={t}><b>{t}</b> — {d}</li>)}</ul>
              <Link href="/catalogue/" className="btn btn-secondary" style={{ marginTop: 8 }}>Browse the loans</Link>
            </div>
          </div>
        </div>
      </section>

      <RecentUploads />
    </>
  );
}
