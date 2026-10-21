import type { Metadata } from "next";
import { UploadFlow } from "@/components/upload/UploadFlow";

export const metadata: Metadata = { title: "Upload" };

export default function UploadPage() {
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <span className="eyebrow">New upload</span>
          <h1>Upload a lead list</h1>
          <p>We check your columns first, then upload securely. Validation, matching and emails start automatically.</p>
        </div>
      </div>
      <UploadFlow />
    </div>
  );
}
