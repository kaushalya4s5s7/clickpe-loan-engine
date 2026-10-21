"use client";

// The upload journey: 1 choose → 2 check columns (in the browser) → 3 upload → hand off to the
// batch page, which shows validation, matching and emails live.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../ApiProvider";
import { ErrorNote, Icon } from "../ui";
import { ColumnCheck } from "./ColumnCheck";
import { DropZone } from "./DropZone";
import { FormatGuide } from "./FormatGuide";
import styles from "./upload.module.css";
import { useLoad } from "@/hooks/useLoad";
import { ApiError } from "@/lib/api/client.ts";
import { inspectCsv, SNIFF_BYTES, type Inspection } from "@/lib/csv/inspect.ts";
import { bytes } from "@/lib/format.ts";
import { uploadFile, type SessionStore, type UploadProgress } from "@/lib/upload/multipart.ts";

type Phase = "choose" | "check" | "uploading" | "paused";

const browserStore: SessionStore = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* resume unavailable */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export function UploadFlow() {
  const router = useRouter();
  const { api, hasKey, requestKey } = useApi();
  const schema = useLoad((a) => a.schema());
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [phase, setPhase] = useState<Phase>("choose");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aborter = useRef<AbortController | null>(null);
  const started = useRef(0);

  // Inspect the first 64 KB as soon as a file is chosen (and the schema is known).
  useEffect(() => {
    if (!file || !schema.data) return;
    let alive = true;
    file.slice(0, SNIFF_BYTES).arrayBuffer().then((buf) => {
      if (!alive) return;
      setInspection(inspectCsv(new Uint8Array(buf), file.size, schema.data!));
      setPhase("check");
    });
    return () => { alive = false; };
  }, [file, schema.data]);

  // Leaving mid-upload loses nothing (it resumes), but warn anyway.
  useEffect(() => {
    if (phase !== "uploading") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  const choose = (f: File) => { setFile(f); setInspection(null); setError(null); setProgress(null); setPhase("choose"); };

  const start = async () => {
    if (!file) return;
    if (!hasKey) { requestKey(); return; }
    setError(null);
    setPhase("uploading");
    aborter.current = new AbortController();
    started.current = performance.now();
    try {
      const batchId = await uploadFile(file, { api, store: browserStore, signal: aborter.current.signal, onProgress: setProgress });
      router.push(`/batch/?id=${encodeURIComponent(batchId)}`);
    } catch (err) {
      if (aborter.current?.signal.aborted) { setPhase("paused"); return; }
      if (err instanceof ApiError && err.isAuth) requestKey();
      setError(err instanceof Error ? err.message : String(err));
      setPhase("paused");
    }
  };

  const pause = () => aborter.current?.abort();

  const step = phase === "choose" ? 1 : phase === "check" ? 2 : 3;
  const pct = progress ? Math.round((100 * progress.bytesDone) / Math.max(1, progress.bytesTotal)) : 0;
  const elapsed = (performance.now() - started.current) / 1000;
  const speed = progress && elapsed > 1 ? progress.bytesDone / elapsed : 0;
  const eta = speed > 0 && progress ? Math.ceil((progress.bytesTotal - progress.bytesDone) / speed) : null;

  return (
    <div className={styles.layout}>
      <div className={`card ${styles.main}`}>
        <ol className={styles.stepper} aria-label="Upload steps">
          {["Choose file", "Check columns", "Upload"].map((label, i) => (
            <li key={label} className={i + 1 < step ? styles.ok : i + 1 === step ? styles.on : ""} aria-current={i + 1 === step ? "step" : undefined}>
              <span className={styles.n}>{i + 1 < step ? "✓" : i + 1}</span>{label}
            </li>
          ))}
        </ol>

        <DropZone file={file} onFile={choose} disabled={phase === "uploading"} />

        {schema.error && <ErrorNote title="Couldn't load the file format" message={schema.error.message} onRetry={schema.reload} />}

        {inspection && phase !== "uploading" && (
          inspection.problem && inspection.matches.length === 0
            ? <ErrorNote title="This file can't be processed" message={inspection.problem} />
            : <>
                {inspection.problem && (
                  <div className="alert alert-bad" role="alert">
                    <div><strong>{inspection.problem}</strong>Rename the column in your sheet (aliases are listed on the right) or download the template.</div>
                  </div>
                )}
                <ColumnCheck inspection={inspection} />
              </>
        )}

        {(phase === "uploading" || phase === "paused") && progress && (
          <div aria-live="polite">
            <div className={styles.progressHead}>
              <div><b>{pct}%</b> <span className="muted">{bytes(progress.bytesDone)} of {bytes(progress.bytesTotal)}</span></div>
              <span className="muted small">
                {phase === "paused" ? "Paused — click Resume to continue" :
                  `part ${progress.partsDone} of ${progress.partCount}${eta !== null ? ` · about ${eta}s left` : ""}${progress.resumed ? " · resumed" : ""}`}
              </span>
            </div>
            <div className="progress"><span style={{ width: `${pct}%` }} /></div>
          </div>
        )}

        {error && <ErrorNote title="Upload interrupted" message={`${error} Your progress is saved — Resume continues from the last finished part.`} />}

        <div className={styles.actions}>
          {phase === "uploading" ? (
            <button className="btn btn-secondary" onClick={pause}>Pause</button>
          ) : (
            <button className="btn btn-lg" onClick={start}
                    disabled={!file || !inspection || (phase === "check" && !inspection.ok)}>
              <Icon name="upload" /> {phase === "paused" ? "Resume upload" : file ? `Upload ${bytes(file.size)}` : "Upload"}
            </button>
          )}
        </div>
      </div>

      <aside className="stack">
        <FormatGuide columns={schema.data} />
        <div className="card card-pad small" style={{ color: "var(--text-2)" }}>
          <strong style={{ color: "var(--text)" }}>Good to know</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>
            <li>If your connection drops, choose the same file again — the upload continues where it stopped.</li>
            <li>Rows with problems are skipped and listed with their row number; if more than 20% are bad, nothing is saved.</li>
            <li>Uploading the same people again updates only what changed — nobody gets the same offer twice.</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
