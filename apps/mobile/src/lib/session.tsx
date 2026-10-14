import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, loadToken, setToken } from './api';
import { registerPush } from './push';

export interface Me {
  id: string;
  kind: string;
  handle: string | null;
  email: string;
  phone: string | null;
  displayName: string | null;
  verifiedName: string | null;
  tier: string;
  status: string;
  suspendedReason: string | null;
  reverifyRequired: boolean;
  reverifyReason: string | null;
  outgoingLockedUntil: string | null;
  limits: { perTransaction: string; daily: string; remainingToday: string };
}

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => Promise<void>; signIn: (t: string) => Promise<void>; signOut: () => Promise<void> }>({
  me: null,
  loading: true,
  refresh: async () => {},
  signIn: async () => {},
  signOut: async () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      if (!(await loadToken())) return setMe(null);
      setMe(await api.get<Me>('/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <Ctx.Provider
      value={{
        me,
        loading,
        refresh,
        signIn: async (t) => {
          await setToken(t);
          await refresh();
          await registerPush().catch(() => undefined);
        },
        signOut: async () => {
          await api.post('/auth/logout').catch(() => undefined);
          await setToken(null);
          setMe(null);
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useSession = () => useContext(Ctx);
