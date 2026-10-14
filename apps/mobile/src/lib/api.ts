// API client for the mobile app. The session token lives in the OS keystore (SecureStore).
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

const BASE: string = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'http://localhost:4000';
let token: string | null = null;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function loadToken(): Promise<string | null> {
  token = await SecureStore.getItemAsync('bs_session');
  return token;
}

export async function setToken(t: string | null): Promise<void> {
  token = t;
  if (t) await SecureStore.setItemAsync('bs_session', t);
  else await SecureStore.deleteItemAsync('bs_session');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Retries on weak networks for idempotent reads only (NFR Connectivity); writes carry
  // idempotency keys where retrying could repeat an effect.
  const attempts = method === 'GET' ? 3 : 1;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Something went wrong. Try again.');
      return data as T;
    } catch (e) {
      last = e;
      if (e instanceof ApiError) throw e;
      await new Promise<void>((r) => setTimeout(() => r(), 500 * 2 ** i));
    }
  }
  throw last instanceof Error ? last : new Error('Network error. Check your connection.');
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T = any>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
};
