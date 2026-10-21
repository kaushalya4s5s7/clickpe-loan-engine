"use client";

// Owns the API key (per browser) and the typed API client. Anything that needs the backend calls
// useApi(); an auth failure anywhere opens the key dialog instead of showing a dead page.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createApi, type Api } from "@/lib/api/client.ts";
import { API_URL } from "@/lib/config.ts";

const STORAGE_KEY = "loan-engine.api-key";

interface ApiContextValue {
  api: Api;
  configured: boolean;     // false when NEXT_PUBLIC_API_URL wasn't set at build time
  hasKey: boolean;
  requestKey: () => void;  // open the dialog (e.g. after a 403)
  saveKey: (key: string) => void;
  dialogOpen: boolean;
  closeDialog: () => void;
}

const ApiContext = createContext<ApiContextValue | null>(null);

function readKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return ""; // storage can be unavailable (private mode, blocked site data)
  }
}

export function ApiProvider({ children }: { children: ReactNode }) {
  const keyRef = useRef("");
  const [hasKey, setHasKey] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    keyRef.current = readKey();
    setHasKey(Boolean(keyRef.current));
  }, []);

  const api = useMemo(() => createApi({ baseUrl: API_URL, getApiKey: () => keyRef.current }), []);

  const saveKey = useCallback((key: string) => {
    keyRef.current = key.trim();
    try {
      localStorage.setItem(STORAGE_KEY, keyRef.current);
    } catch {
      /* key still works for this tab */
    }
    setHasKey(Boolean(keyRef.current));
    setDialogOpen(false);
  }, []);

  // Stable identities: hooks list these in effect deps, so they must not change on every render.
  const requestKey = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  const value = useMemo<ApiContextValue>(() => ({
    api, configured: Boolean(API_URL), hasKey, saveKey, dialogOpen, requestKey, closeDialog,
  }), [api, hasKey, saveKey, dialogOpen, requestKey, closeDialog]);

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiContextValue {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApi must be used inside <ApiProvider>");
  return ctx;
}
