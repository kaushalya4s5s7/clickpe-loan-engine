import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createApi } from "./client.ts";

test("sends the API key and maps the error model", async () => {
  const seen: { url: string; key: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, key: new Headers(init.headers).get("X-Api-Key") });
    if (url.endsWith("/v1/batches/nope")) {
      return new Response(JSON.stringify({ error: { code: "BATCH_NOT_FOUND", message: "no such batch" } }), { status: 404 });
    }
    if (url.endsWith("/v1/products")) return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
    return new Response(JSON.stringify({ columns: [{ name: "age" }] }), { status: 200 });
  }) as typeof fetch;
  const api = createApi({ baseUrl: "https://api/dev", getApiKey: () => "k-1", fetchImpl });

  assert.deepEqual(await api.schema(), [{ name: "age" }]);
  assert.deepEqual(seen[0], { url: "https://api/dev/v1/uploads/schema", key: "k-1" });
  await assert.rejects(api.batch("nope"), (e: unknown) => e instanceof ApiError && e.code === "BATCH_NOT_FOUND" && e.status === 404);
  await assert.rejects(api.products(), (e: unknown) => e instanceof ApiError && e.isAuth);
});

test("network failures become a friendly error", async () => {
  const api = createApi({ baseUrl: "", getApiKey: () => "", fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
  await assert.rejects(api.overview(), (e: unknown) => e instanceof ApiError && e.code === "NETWORK");
});
