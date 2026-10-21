import assert from "node:assert/strict";
import test from "node:test";
import type { Api } from "../api/client.ts";
import { sha256Base64, uploadFile, type SessionStore } from "./multipart.ts";

function memoryStore(): SessionStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) };
}

/** A fake API + storage: records which parts were PUT and can fail on demand. */
function fakeBackend(partSize: number) {
  const stored = new Set<number>();
  const calls: string[] = [];
  let failNextPut = 0;
  const api = {
    createUpload: async (_n: string, size: number) => { calls.push("create"); return { batch_id: "b1", part_size: partSize, part_count: Math.ceil(size / partSize), max_parallel: 2 }; },
    uploadedParts: async () => { calls.push("list"); return [...stored].map((n) => ({ part_number: n, etag: "e", size: partSize })); },
    partUrls: async (_b: string, parts: { part_number: number; sha256: string }[]) =>
      parts.map((p) => ({ part_number: p.part_number, url: `s3://part/${p.part_number}`, headers: { "x-amz-checksum-sha256": p.sha256 } })),
    complete: async () => { calls.push("complete"); return { batch_id: "b1", size_bytes: 0, status: "UPLOADED" }; },
  } as unknown as Api;
  const putPart = async (url: string, _b: Blob, headers: Record<string, string>) => {
    assert.ok(headers["x-amz-checksum-sha256"]?.length === 44, "every part carries its SHA-256");
    if (failNextPut > 0) { failNextPut--; return 503; }
    stored.add(Number(url.split("/").pop()));
    return 200;
  };
  return { api, putPart, stored, calls, failOnce: (n = 1) => { failNextPut = n; } };
}

const file = (size: number) => new File([new Uint8Array(size).fill(65)], "users.csv", { lastModified: 1 });
const noSleep = async () => {};

test("uploads every part, retries a transient failure, completes and forgets the session", async () => {
  const b = fakeBackend(10);
  const store = memoryStore();
  b.failOnce(2);
  const progress: number[] = [];
  const id = await uploadFile(file(35), { api: b.api, store, putPart: b.putPart, sleep: noSleep, onProgress: (p) => progress.push(p.partsDone) });
  assert.equal(id, "b1");
  assert.deepEqual([...b.stored].sort(), [1, 2, 3, 4]);
  assert.equal(progress.at(-1), 4);
  assert.equal(store.data.size, 0);
  assert.deepEqual(b.calls, ["create", "complete"]);
});

test("resumes: parts already in storage are not sent again", async () => {
  const b = fakeBackend(10);
  const store = memoryStore();
  const f = file(35);
  b.failOnce(100); // the "network" dies after the session starts
  await assert.rejects(uploadFile(f, { api: b.api, store, putPart: b.putPart, sleep: noSleep, maxRetries: 0 }));
  assert.equal(store.data.size, 1, "session remembered for resume");
  b.failOnce(0);
  b.stored.add(1); b.stored.add(2);
  let resumed = false;
  await uploadFile(f, { api: b.api, store, putPart: b.putPart, sleep: noSleep, onProgress: (p) => { resumed = p.resumed; } });
  assert.equal(resumed, true);
  assert.deepEqual(b.calls.filter((c) => c === "create").length, 1, "no second session");
});

test("SHA-256 fallback (plain-HTTP pages have no crypto.subtle) matches WebCrypto", async () => {
  const blob = new Blob(["user_id,name\n1,Asha\n".repeat(1000)]);
  const native = await sha256Base64(blob);
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    assert.equal(await sha256Base64(blob), native);
  } finally {
    Object.defineProperty(globalThis, "crypto", real);
  }
});
