"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApi } from "./ApiProvider";
import styles from "./Nav.module.css";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/history/", label: "Uploads" },
  { href: "/catalogue/", label: "Loan catalogue" },
];

export function Nav() {
  const pathname = usePathname() ?? "/";
  const { hasKey, requestKey } = useApi();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href.replace(/\/$/, "")) || (href === "/history/" && pathname.startsWith("/batch"));

  return (
    <header className={styles.bar}>
      <nav className={`container ${styles.inner}`} aria-label="Main">
        <Link href="/" className={styles.brand}>Loan Match</Link>
        <div className={styles.links}>
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={`${styles.link} ${isActive(l.href) ? styles.active : ""}`}
                  aria-current={isActive(l.href) ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
        </div>
        <div className={styles.actions}>
          <button className={`btn btn-secondary ${styles.hideSm}`} onClick={requestKey}>{hasKey ? "Connected ✓" : "Connect"}</button>
          <Link href="/upload/" className="btn">Upload a list</Link>
        </div>
      </nav>
    </header>
  );
}
