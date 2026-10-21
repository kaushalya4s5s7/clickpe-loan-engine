"use client";

// Poll an endpoint with backoff (1 s → 5 s) until `done(data)` says the job is finished.
// Pipelines take seconds to minutes; WebSockets would add infrastructure for no user-visible gain.

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/components/ApiProvider";
import { ApiError, type Api } from "@/lib/api/client.ts";

export function usePolling<T>(fetcher: (api: Api) => Promise<T>, done: (data: T) => boolean, key: string | null) {
  const { api, hasKey, requestKey } = useApi();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const fetchRef = useRef(fetcher);
  const doneRef = useRef(done);
  fetchRef.current = fetcher;
  doneRef.current = done;

  useEffect(() => {
    if (!key) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let delay = 1000;
    const tick = async () => {
      try {
        const next = await fetchRef.current(api);
        if (!alive) return;
        setData(next);
        setError(null);
        if (doneRef.current(next)) return;
      } catch (err) {
        if (!alive) return;
        const e = err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", String(err));
        setError(e);
        if (e.isAuth || e.status === 404) { if (e.isAuth) requestKey(); return; }
      }
      timer = setTimeout(tick, delay);
      delay = Math.min(5000, Math.round(delay * 1.5));
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [api, hasKey, key, requestKey]);

  return { data, error };
}
