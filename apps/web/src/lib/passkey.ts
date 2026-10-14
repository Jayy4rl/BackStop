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

/** Passkey confirmation before a payment or release; returns the unlocked wallet key. */
export async function confirmWithPasskey(): Promise<Hex> {
  const o = await api.post('/auth/step-up/options');
  const salt = await prfSalt();
  const cred = await authenticate(o.options, { prf: { eval: { first: new Uint8Array(salt) } } });
  await api.post('/auth/step-up/finish', { challengeId: o.challengeId, credential: cred });
  const prf = (cred.clientExtensionResults as { prf?: { results?: { first?: ArrayBuffer | string } } }).prf?.results?.first;
  const out = typeof prf === 'string' ? Uint8Array.from(atob(prf.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer : (prf ?? null);
  return unlock(out, out ? salt : null);
}
