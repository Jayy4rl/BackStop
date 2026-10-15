import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, hasToken, setToken } from './api';

export interface Me {
  id: string;
  kind: 'individual' | 'business' | 'counterparty';
  handle: string | null;
  email: string;
  phone: string | null;
  phoneDiscoverable: boolean;
  displayName: string | null;
  verifiedName: string | null;
  country: string;
  tier: 'none' | 'tier1' | 'tier2' | 'counterparty';
  status: string;
  suspendedReason: string | null;
  reverifyRequired: boolean;
  reverifyReason: string | null;
  outgoingLockedUntil: string | null;
  demo: boolean;
  hasPasskey: boolean;
  newPayeeThreshold: string | null;
  wallet: { evmAddress: string; tronAddress: string; provider: string } | null;
  business: { company_name: string; verified_at: string | null } | null;
  businessMemberships: Array<{ business_id: string; role: string; company_name: string }>;
  limits: { perTransaction: string; daily: string; usedToday: string; remainingToday: string; resetsAt: string; counterpartyVerificationThreshold: string | null };
}

interface SessionCtx {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionCtx>({ me: null, loading: true, refresh: async () => {}, signIn: async () => {}, signOut: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    if (!hasToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await api.get<Me>('/me'));
    } catch {
      setToken(null);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const signIn = async (t: string) => {
    setToken(t);
    await refresh();
  };
  const signOut = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setToken(null);
    setMe(null);
  };
  return <Ctx.Provider value={{ me, loading, refresh, signIn, signOut }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
