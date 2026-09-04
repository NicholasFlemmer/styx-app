// Ambient fallback; replaced by the package's own types once @napi-rs/keyring is installed.
declare module '@napi-rs/keyring' {
  export class Entry {
    constructor(service: string, account: string);
    getPassword(): string | null;
    setPassword(password: string): void;
    deletePassword(): boolean;
  }
  export function findCredentials(service: string): { account: string; password: string }[];
}
