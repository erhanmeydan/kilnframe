import { AsyncEntry } from "@napi-rs/keyring";

/** API keys never touch files, logs or error messages. */
export interface KeyStore {
  get(provider: string): Promise<string | undefined>;
  set(provider: string, key: string): Promise<void>;
  delete(provider: string): Promise<boolean>;
}

export const KEYCHAIN_SERVICE = "kilnframe";

/** macOS Keychain / Windows Credential Manager through @napi-rs/keyring. */
export class OsKeyStore implements KeyStore {
  constructor(private readonly service = KEYCHAIN_SERVICE) {}

  private entry(provider: string) {
    return new AsyncEntry(this.service, provider);
  }

  async get(provider: string) {
    return (await this.entry(provider).getPassword()) ?? undefined;
  }

  async set(provider: string, key: string) {
    await this.entry(provider).setPassword(key);
  }

  async delete(provider: string) {
    return this.entry(provider).deletePassword();
  }
}

export class MemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, string>();

  async get(provider: string) {
    return this.keys.get(provider);
  }

  async set(provider: string, key: string) {
    this.keys.set(provider, key);
  }

  async delete(provider: string) {
    return this.keys.delete(provider);
  }
}
