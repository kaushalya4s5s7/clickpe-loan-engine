// Resumable, checksummed multipart upload straight to S3 (docs/DESIGN.md §9.1).
// Framework-free: React only renders the progress this module reports.
//
//  1. ask the API for a session (it caps the size and the number of parts)
//  2. for each part: SHA-256 in the browser → presigned URL signed WITH that checksum → PUT to S3
//     (S3 rejects the part if a single byte differs)
//  3. up to `max_parallel` parts in flight; each retried with exponential backoff + full jitter
//  4. on refresh / network loss: the same file resumes — the server lists the parts S3 already has
//  5. complete → the server verifies every part and the total size, then S3 emits the event

import { sha256 as nobleSha256 } from "@noble/hashes/sha2";
import type { Api } from "../api/client.ts";
import type { UploadSession } from "../api/types.ts";

export interface UploadProgress {
  batchId: string;
  partsDone: number;
  partCount: number;
  bytesDone: number;
  bytesTotal: number;
  resumed: boolean;
}

/** Where resumable sessions are remembered (localStorage in the browser, a Map in tests). */
export interface SessionStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface UploadOptions {
  api: Api;
  store: SessionStore;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
  maxRetries?: number;
  putPart?: (url: string, body: Blob, headers: Record<string, string>, signal?: AbortSignal) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultPut = async (url: string, body: Blob, headers: Record<string, string>, signal?: AbortSignal) =>
  (await fetch(url, { method: "PUT", body, headers, signal })).status;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const fingerprint = (file: File) => `upload:${file.name}:${file.size}:${file.lastModified}`;

export async function sha256Base64(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  // crypto.subtle exists only on HTTPS/localhost; the plain-HTTP S3 website (no-CDN deploy) needs the JS fallback.
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    : nobleSha256(new Uint8Array(bytes));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function uploadFile(file: File, opts: UploadOptions): Promise<string> {
  const { api, store, onProgress, signal, maxRetries = 5, putPart = defaultPut, sleep = defaultSleep } = opts;
  const key = fingerprint(file);

  let session: UploadSession | null = null;
  let done = new Set<number>();
  const saved = store.get(key);
  if (saved) {
    try {
      session = JSON.parse(saved) as UploadSession;
      done = new Set((await api.uploadedParts(session.batch_id, signal)).map((p) => p.part_number));
    } catch {
      session = null; // expired or already completed: start fresh
      done = new Set();
      store.remove(key);
    }
  }
  const resumed = session !== null;
  if (!session) {
    session = await api.createUpload(file.name, file.size, signal);
    store.set(key, JSON.stringify(session));
  }
  const s = session;

  const partBytes = (n: number) => Math.min(s.part_size, file.size - (n - 1) * s.part_size);
  let bytesDone = [...done].reduce((sum, n) => sum + partBytes(n), 0);
  const report = () => onProgress?.({ batchId: s.batch_id, partsDone: done.size, partCount: s.part_count, bytesDone,
                                     bytesTotal: file.size, resumed });
  report();

  const queue = Array.from({ length: s.part_count }, (_, i) => i + 1).filter((n) => !done.has(n));

  async function sendPart(n: number): Promise<void> {
    const blob = file.slice((n - 1) * s.part_size, n * s.part_size);
    for (let attempt = 0; ; attempt++) {
      try {
        const checksum = await sha256Base64(blob);
        const [url] = await api.partUrls(s.batch_id, [{ part_number: n, sha256: checksum }], signal);
        if (!url) throw new Error("no upload URL returned");
        const status = await putPart(url.url, blob, url.headers, signal);
        if (status < 200 || status >= 300) throw new Error(`storage rejected part ${n} (HTTP ${status})`);
        return;
      } catch (err) {
        if (signal?.aborted || attempt >= maxRetries) throw err;
        await sleep(Math.random() * Math.min(30_000, 500 * 2 ** attempt)); // full jitter: retries don't stampede
      }
    }
  }

  const worker = async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      await sendPart(n);
      done.add(n);
      bytesDone += partBytes(n);
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(s.max_parallel, queue.length)) }, worker));

  await api.complete(s.batch_id, signal);
  store.remove(key);
  return s.batch_id;
}
