import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { useState } from "react";

const CLIENT_ID_KEY = "arena:clientId";

/** ID stabil per browser — dipakai sebagai kunci sesi di database. */
export function getClientId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `client-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    window.localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

/**
 * Sesi arena.ai milik browser ini.
 * `session` = null (belum login) | data sesi | undefined (masih loading).
 */
export function useArenaSession() {
  const [clientId] = useState<string>(getClientId);
  const session = useQuery(
    api.arenaSession.me,
    clientId ? { clientId } : "skip",
  );
  return { clientId, session, isLoading: session === undefined };
}
