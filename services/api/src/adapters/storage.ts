// Evidence and document storage, encrypted at rest (C4-8: evidence stored encrypted off-chain).
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Crypto } from '../lib/crypto.ts';

export interface BlobStore {
  readonly name: string;
  put(data: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Local filesystem store; every object is AES-256-GCM encrypted with the storage key as AAD. */
export class LocalEncryptedStore implements BlobStore {
  readonly name = 'local';
  constructor(private readonly dir: string, private readonly crypto: Crypto) {}
  async put(data: Buffer): Promise<string> {
    const key = randomUUID();
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, key), this.crypto.encrypt(data, `blob:${key}`));
    return key;
  }
  async get(key: string): Promise<Buffer> {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('bad storage key');
    return this.crypto.decrypt(await readFile(join(this.dir, key)), `blob:${key}`);
  }
  async delete(key: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('bad storage key');
    await rm(join(this.dir, key), { force: true });
  }
}

export function createBlobStore(name: string, dir: string, crypto: Crypto): BlobStore {
  if (name === 'local') return new LocalEncryptedStore(dir, crypto);
  throw new Error(`storage adapter "${name}" is not integrated yet`);
}
