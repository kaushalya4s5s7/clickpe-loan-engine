import type { Metadata } from "next";
import { Catalogue } from "@/components/Catalogue";

export const metadata: Metadata = { title: "Loan catalogue" };

export default function CataloguePage() {
  return (
    <div className="container page">
      <div className="page-head">
        <div>
          <span className="eyebrow">Loan catalogue</span>
          <h1>Personal loans we match against</h1>
          <p>Read daily from each lender&apos;s own website. Every number is backed by a quote from the page.</p>
        </div>
      </div>
      <Catalogue />
    </div>
  );
}
