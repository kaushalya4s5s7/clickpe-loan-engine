"use client";

import { useApi } from "./ApiProvider";

/** Shown only on a build made without NEXT_PUBLIC_API_URL — a deploy mistake, said plainly. */
export function SetupNotice() {
  const { configured } = useApi();
  if (configured) return null;
  return (
    <div className="container" style={{ paddingTop: 16 }}>
      <div className="alert alert-warn">
        <div>
          <strong>API address not configured</strong>
          This build was made without <code>NEXT_PUBLIC_API_URL</code>. Set it in <code>apps/web/.env.local</code> and rebuild.
        </div>
      </div>
    </div>
  );
}
