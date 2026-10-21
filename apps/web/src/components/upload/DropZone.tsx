"use client";

import { useRef, useState, type DragEvent } from "react";
import { bytes } from "@/lib/format.ts";
import { Icon } from "../ui";
import styles from "./upload.module.css";

export function DropZone({ file, onFile, disabled }: { file: File | null; onFile: (f: File) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f && !disabled) onFile(f);
  };
  return (
    <div
      role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
      aria-label={file ? `Selected ${file.name}. Choose a different file` : "Choose a CSV file"}
      className={`${styles.drop} ${over ? styles.over : ""} ${file ? styles.hasFile : ""}`}
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !disabled) { e.preventDefault(); input.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <div className={styles.dropIcon}><Icon name={file ? "file" : "upload"} size={22} /></div>
      {file ? (
        <>
          <div className={styles.dropTitle}>{file.name}</div>
          <div className="muted small">{bytes(file.size)} · click to choose a different file</div>
        </>
      ) : (
        <>
          <div className={styles.dropTitle}>Drop your CSV here, or <span className={styles.linkish}>browse</span></div>
          <div className="muted small">.csv, .tsv or .txt up to 200 MB · exported from Excel or Google Sheets</div>
        </>
      )}
      <input ref={input} type="file" hidden accept=".csv,.tsv,.txt,text/csv"
             onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </div>
  );
}
