import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="container page">
      <div className="card"><EmptyState title="Page not found" action={<Link href="/" className="btn">Back to overview</Link>} /></div>
    </div>
  );
}
