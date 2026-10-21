"use client";

// Load data once (or when deps change) with loading/error state. Auth failures open the key
// dialog; once a key is saved the request is retried automatically.

import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/components/ApiProvider";
import { ApiError, type Api } from "@/lib/api/client.ts";

export interface Loaded<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

export function useLoad<T>(fetcher: (api: Api) => Promise<T>, deps: unknown[] = [], enabled = true): Loaded<T> {
  const { api, hasKey, requestKey } = useApi();
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({
    data: null, error: null, loading: enabled,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcher(api)
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((err: unknown) => {
        if (!alive) return;
        const error = err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", String(err));
        if (error.isAuth) requestKey();
        setState({ data: null, error, loading: false });
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, hasKey, tick, enabled, ...deps]);

  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}
