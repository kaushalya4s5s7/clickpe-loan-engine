"use client";

import Link from "next/link";
import { useApi } from "./ApiProvider";
import { BatchTable } from "./BatchTable";
import { EmptyState, ErrorNote, Skeleton } from "./ui";
import { useLoad } from "@/hooks/useLoad";

export function History() {
  const { hasKey, requestKey } = useApi();
  const { data, error, loading, reload } = useLoad((api) => api.batches(50), [], hasKey);
  if (!hasKey) return <div className="card"><EmptyState title="Connect to see uploads" action={<button className="btn" onClick={requestKey}>Add API key</button>}>Uploads are private to your team.</EmptyState></div>;
  if (error) return <ErrorNote message={error.message} onRetry={reload} />;
  if (loading || !data) return <div className="card card-pad stack"><Skeleton /><Skeleton /><Skeleton /></div>;
  if (!data.length) return <div className="card"><EmptyState title="No uploads yet" action={<Link href="/upload/" className="btn">Upload a lead list</Link>}>Your first upload will appear here.</EmptyState></div>;
  return <div className="card"><BatchTable batches={data} /></div>;
}
