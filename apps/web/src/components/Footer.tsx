import Link from "next/link";
import styles from "./Footer.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className="container">
        <div className={styles.cta}>
          <h2>Your next list is ready to match.</h2>
          <p>Upload a CSV. Validation, matching and emails run on their own.</p>
          <Link href="/upload/" className="btn">Upload a lead list</Link>
        </div>
        <div className={styles.meta}>
          <span>© {new Date().getFullYear()} Loan Match · ClickPe</span>
          <span>Matches are indicative, based on criteria lenders publish. Lenders make the final decision.</span>
        </div>
      </div>
      <div className={styles.wordmark} aria-hidden>Loan Match</div>
    </footer>
  );
}
