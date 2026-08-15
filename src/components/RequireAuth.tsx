import { useAuth } from "@/hooks/use-auth";
import { useArenaSession } from "@/hooks/use-arena-session";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  const { session, isLoading: arenaLoading } = useArenaSession();
  const location = useLocation();

  if (authLoading || arenaLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  // Boleh masuk kalau: sudah login ke web ini (password / kode email) ATAU
  // sudah punya sesi arena.ai aktif (cara lama — login cookie saja).
  if (!isAuthenticated && !session) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/auth?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  return children;
}
