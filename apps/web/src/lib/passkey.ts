// Passkey ceremonies. Step-up confirmations also unlock the device wallet (with PRF when available).
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { Hex } from 'viem';
import { api } from './api';
import { prfSalt, unlock } from './wallet';

export function deviceFingerprint(): string {
  try {
    let id = localStorage.getItem('bs_device');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('bs_device', id);
    }
    return id;
  } catch {
    return `ephemeral-${crypto.randomUUID()}`;
  }
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  return /Android/.test(ua) ? 'Android browser' : /iPhone|iPad/.test(ua) ? 'iOS browser' : 'Web browser';
}

export async function register(options: any) {
  return startRegistration({ optionsJSON: options });
}

export async function authenticate(options: any, extensions?: Record<string, unknown>) {
  return startAuthentication({ optionsJSON: { ...options, extensions: { ...(options.extensions ?? {}), ...extensions } } });
}

/**
 * A demo account has no passkey until its first confirmation: create it then. The registration
 * verifies the user, so the server counts it as the step-up. Returns false if a passkey exists.
 */
export async function createFirstDemoPasskey(): Promise<boolean> {
  const me = await api.get<{ demo: boolean; hasPasskey: boolean }>('/me');
  if (!me.demo || me.hasPasskey) return false;
  const o = await api.post('/auth/demo/passkey/options');
  await api.post('/auth/demo/passkey', { challengeId: o.challengeId, credential: await register(o.options), label: deviceLabel() });
  return true;
}

/** Passkey confirmation before a payment or release; returns the unlocked wallet key. */
export async function confirmWithPasskey(): Promise<Hex> {
  if (await createFirstDemoPasskey()) return unlock(null, null);
  const o = await api.post('/auth/step-up/options');
  const salt = await prfSalt();
  const cred = await authenticate(o.options, { prf: { eval: { first: new Uint8Array(salt) } } });
  await api.post('/auth/step-up/finish', { challengeId: o.challengeId, credential: cred });
  const prf = (cred.clientExtensionResults as { prf?: { results?: { first?: ArrayBuffer | string } } }).prf?.results?.first;
  const out = typeof prf === 'string' ? Uint8Array.from(atob(prf.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer : (prf ?? null);
  return unlock(out, out ? salt : null);
}
