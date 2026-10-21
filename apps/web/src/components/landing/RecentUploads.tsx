"use client";

import Link from "next/link";
import { useApi } from "../ApiProvider";
import { BatchTable } from "../BatchTable";
import { useLoad } from "@/hooks/useLoad";

export function RecentUploads() {
  const { hasKey } = useApi();
  const { data } = useLoad((api) => api.batches(5), [], hasKey);
  if (!hasKey || !data?.length) return null;
  return (
    <section className="container" style={{ padding: "0 24px 80px" }}>
      <div className="card">
        <div className="card-head"><h2>Recent uploads</h2><Link href="/history/" className="small">View all</Link></div>
        <BatchTable batches={data} />
      </div>
    </section>
  );
}
