"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useApi } from "./ApiProvider";

// Native <dialog>: focus trapping, Esc to close and the backdrop come from the browser.
export function ApiKeyDialog() {
  const { dialogOpen, closeDialog, saveKey } = useApi();
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (dialogOpen && !d.open) d.showModal();
    if (!dialogOpen && d.open) d.close();
  }, [dialogOpen]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) saveKey(value);
    setValue("");
  };

  return (
    <dialog ref={ref} onClose={closeDialog} aria-labelledby="key-title"
            style={{ border: "1px solid var(--line)", borderRadius: 16, padding: 0, width: "min(440px, calc(100vw - 32px))",
                     background: "var(--surface)", color: "var(--text)", boxShadow: "var(--shadow-lg)" }}>
      <form onSubmit={submit} style={{ padding: 24, display: "grid", gap: 16 }}>
        <div>
          <h2 id="key-title" style={{ fontSize: 18 }}>Connect to the Loan Engine</h2>
          <p className="muted small" style={{ marginTop: 6 }}>
            Paste the API key from <code>npx serverless@3 info</code>. It is stored only in this browser and sent as the
            <code> x-api-key</code> header.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="api-key">API key</label>
          <input id="api-key" className="input" type="password" autoComplete="off" value={value}
                 onChange={(e) => setValue(e.target.value)} placeholder="e.g. a1B2c3…" autoFocus />
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-secondary" onClick={closeDialog}>Cancel</button>
          <button type="submit" className="btn" disabled={!value.trim()}>Save key</button>
        </div>
      </form>
    </dialog>
  );
}
