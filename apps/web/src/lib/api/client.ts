// Typed client for the Loan Engine API — the ONLY module in the console that calls the backend.
// Components and pages depend on this contract, never on fetch() or URLs directly.

import type {
  BatchListItem, BatchView, ColumnSpec, LoanProduct, Overview, PartUrl, UploadedPart, UploadSession,
} from "./types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  /** API Gateway answers 403 "Forbidden" when the x-api-key header is missing or wrong. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface ApiOptions {
  baseUrl: string;
  getApiKey: () => string;
  fetchImpl?: typeof fetch;
}

export function createApi({ baseUrl, getApiKey, fetchImpl = (...a) => fetch(...a) }: ApiOptions) {
  async function request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        signal,
        headers: { "Content-Type": "application/json", "X-Api-Key": getApiKey() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ApiError(0, "NETWORK", "Can't reach the server. Check your connection and try again.");
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string }; message?: string };
      const message = data.error?.message ?? data.message ?? `Request failed (${res.status})`;
      throw new ApiError(res.status, data.error?.code ?? (res.status === 403 ? "FORBIDDEN" : "HTTP_ERROR"), message);
    }
    return res;
  }

  const json = async <T,>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const res = await request(method, path, body, signal);
    return (res.status === 204 ? null : await res.json()) as T;
  };
  const id = encodeURIComponent;

  return {
    overview: () => json<Overview>("GET", "/v1/overview"),
    schema: () => json<{ columns: ColumnSpec[] }>("GET", "/v1/uploads/schema").then((r) => r.columns),
    products: () => json<{ products: LoanProduct[] }>("GET", "/v1/products").then((r) => r.products),
    batches: (limit = 25) => json<{ batches: BatchListItem[] }>("GET", `/v1/batches?limit=${limit}`).then((r) => r.batches),
    batch: (batchId: string) => json<BatchView>("GET", `/v1/batches/${id(batchId)}`),
    errorsCsv: (batchId: string) => request("GET", `/v1/batches/${id(batchId)}/errors.csv`).then((r) => r.blob()),

    createUpload: (filename: string, sizeBytes: number, signal?: AbortSignal) =>
      json<UploadSession>("POST", "/v1/uploads", { filename, size_bytes: sizeBytes }, signal),
    partUrls: (batchId: string, parts: { part_number: number; sha256: string }[], signal?: AbortSignal) =>
      json<{ urls: PartUrl[] }>("POST", `/v1/uploads/${id(batchId)}/part-urls`, { parts }, signal).then((r) => r.urls),
    uploadedParts: (batchId: string, signal?: AbortSignal) =>
      json<{ parts: UploadedPart[] }>("GET", `/v1/uploads/${id(batchId)}/parts`, undefined, signal).then((r) => r.parts),
    complete: (batchId: string, signal?: AbortSignal) =>
      json<{ batch_id: string; size_bytes: number; status: string }>("POST", `/v1/uploads/${id(batchId)}/complete`, undefined, signal),
    abort: (batchId: string) => json<null>("DELETE", `/v1/uploads/${id(batchId)}`),
  };
}

export type Api = ReturnType<typeof createApi>;
