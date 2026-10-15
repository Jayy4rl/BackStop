// Thin client for the Backstop API. Errors carry the API's plain-language message.
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

let token: string | null = null;
let staffToken: string | null = null;

try {
  token = sessionStorage.getItem('bs_token');
  staffToken = sessionStorage.getItem('bs_staff');
} catch {
  // storage unavailable: session lives in memory only
}

export function setToken(t: string | null) {
  token = t;
  try {
    if (t) sessionStorage.setItem('bs_token', t);
    else sessionStorage.removeItem('bs_token');
  } catch {
    /* ignore */
  }
}
export function setStaffToken(t: string | null) {
  staffToken = t;
  try {
    if (t) sessionStorage.setItem('bs_staff', t);
    else sessionStorage.removeItem('bs_staff');
  } catch {
    /* ignore */
  }
}
export const hasToken = () => !!token;
export const hasStaffToken = () => !!staffToken;

async function request<T>(method: string, path: string, body?: unknown, opts: { staff?: boolean; raw?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  const t = opts.staff ? staffToken : token;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...opts.headers,
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, 'download_failed', 'Download failed.');
    return res as unknown as T;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'Something went wrong. Try again.', e.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b?: unknown, headers?: Record<string, string>) => request<T>('POST', p, b ?? {}, { headers }),
  patch: <T = any>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  del: <T = any>(p: string) => request<T>('DELETE', p),
  upload: async (purpose: string, file: File, opts: { public?: boolean; captchaToken?: string } = {}): Promise<{ id: string; sha256: string }> => {
    const fd = new FormData();
    fd.append('purpose', purpose);
    fd.append('file', file);
    return request('POST', opts.public ? '/public/files' : '/files', fd, { headers: opts.captchaToken ? { 'x-captcha-token': opts.captchaToken } : {} });
  },
  download: async (p: string, filename: string, staff = false) => {
    const res = await request<Response>('GET', p, undefined, { raw: true, staff });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  },
};

export const staffApi = {
  get: <T = any>(p: string) => request<T>('GET', p, undefined, { staff: true }),
  post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}, { staff: true }),
};

export interface PublicConfig {
  networks: Array<{ network: string; label: string; enabled: boolean; escrow: boolean; chainId: number | null; publicRpc: string | null; tokens: Record<string, string>; finality: string; gas: string }>;
  p2pEnabled: boolean;
  demoAccounts: boolean;
  captcha: { provider: string; siteKey: string | null };
  consent: { version: string; text: string };
  walletProvider: string;
}

let configCache: Promise<PublicConfig> | null = null;
export function publicConfig(): Promise<PublicConfig> {
  configCache ??= api.get<PublicConfig>('/public/config');
  return configCache;
}
