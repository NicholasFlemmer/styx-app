/**
 * Secrets live only here (OS keychain) behind a credentialRef. SQLite stores refs, never values.
 * credentialRef format: styx:v1:<provider>:<targetId>:<kind>
 */
export interface CredentialVault {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  exists(ref: string): Promise<boolean>;
  listRefs(): Promise<string[]>;
}

export function makeCredentialRef(provider: string, targetId: string, kind: 'oauth' | 'key' | 'ssh-key-path' | 'refresh' | 'passphrase' | 'cli'): string {
  return `styx:v1:${provider}:${targetId}:${kind}`;
}

/** In-memory vault for tests and `STYX_KEYCHAIN=memory` dev runs. */
export class MemoryVault implements CredentialVault {
  private readonly store = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.store.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.store.set(ref, value);
  }
  async delete(ref: string): Promise<void> {
    this.store.delete(ref);
  }
  async exists(ref: string): Promise<boolean> {
    return this.store.has(ref);
  }
  async listRefs(): Promise<string[]> {
    return [...this.store.keys()];
  }
}

const SERVICE = 'dev.styx';
const CHUNK = 2000; // Windows Credential Manager caps blobs at 2560 bytes; chunk conservatively.

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(v: string): void;
  deletePassword(): boolean;
}
interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
  findCredentials?: (service: string) => { account: string; password: string }[];
}

/** OS keychain vault via @napi-rs/keyring (macOS Keychain / Windows Credential Manager). Loaded lazily so tests never touch it. */
export class KeyringVault implements CredentialVault {
  private mod: KeyringModule | null = null;
  private readonly index = new Set<string>();

  private async load(): Promise<KeyringModule> {
    if (!this.mod) this.mod = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
    return this.mod;
  }

  async get(ref: string): Promise<string | null> {
    const { Entry } = await this.load();
    const meta = new Entry(SERVICE, `${ref}#meta`).getPassword();
    if (meta === null) return new Entry(SERVICE, ref).getPassword();
    const n = Number(meta);
    let out = '';
    for (let i = 0; i < n; i++) {
      const part = new Entry(SERVICE, `${ref}#${i}`).getPassword();
      if (part === null) return null;
      out += part;
    }
    return out;
  }

  async set(ref: string, value: string): Promise<void> {
    const { Entry } = await this.load();
    await this.delete(ref);
    if (value.length <= CHUNK) {
      new Entry(SERVICE, ref).setPassword(value);
    } else {
      const parts = value.match(new RegExp(`[\\s\\S]{1,${CHUNK}}`, 'g')) ?? [];
      parts.forEach((p, i) => new Entry(SERVICE, `${ref}#${i}`).setPassword(p));
      new Entry(SERVICE, `${ref}#meta`).setPassword(String(parts.length));
    }
    this.index.add(ref);
  }

  async delete(ref: string): Promise<void> {
    const { Entry } = await this.load();
    const meta = new Entry(SERVICE, `${ref}#meta`).getPassword();
    if (meta !== null) {
      for (let i = 0; i < Number(meta); i++) new Entry(SERVICE, `${ref}#${i}`).deletePassword();
      new Entry(SERVICE, `${ref}#meta`).deletePassword();
    }
    new Entry(SERVICE, ref).deletePassword();
    this.index.delete(ref);
  }

  async exists(ref: string): Promise<boolean> {
    return (await this.get(ref)) !== null;
  }

  async listRefs(): Promise<string[]> {
    const mod = await this.load();
    if (mod.findCredentials) return mod.findCredentials(SERVICE).map((c) => c.account).filter((a) => !a.includes('#'));
    return [...this.index];
  }
}

export function createVault(kind: string | undefined): CredentialVault {
  return kind === 'memory' ? new MemoryVault() : new KeyringVault();
}
