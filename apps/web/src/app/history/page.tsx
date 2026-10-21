import type { Metadata } from "next";
import Link from "next/link";
import { History } from "@/components/History";

export const metadata: Metadata = { title: "Uploads" };

export default function HistoryPage() {
  return (
    <div className="container page">
      <div className="page-head">
        <div><span className="eyebrow">Uploads</span><h1>All uploads</h1><p>Every file uploaded, newest first. Open one to see its results.</p></div>
        <Link href="/upload/" className="btn">New upload</Link>
      </div>
      <History />
    </div>
  );
}
