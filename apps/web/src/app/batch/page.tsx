import type { Metadata } from "next";
import { Suspense } from "react";
import { BatchDetail } from "@/components/batch/BatchDetail";
import { Skeleton } from "@/components/ui";

export const metadata: Metadata = { title: "Upload details" };

// /batch/?id=<uuid> — a query parameter rather than /batch/[id], because a static export can't
// pre-render pages for ids that don't exist yet.
export default function BatchPage() {
  return (
    <div className="container page">
      <Suspense fallback={<Skeleton height={36} width="50%" />}>
        <BatchDetail />
      </Suspense>
    </div>
  );
}
