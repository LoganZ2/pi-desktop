import { safeStorage } from "electron";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { CREDENTIALS_FILE, readJson, writeJson } from "./paths.js";

interface StoredEntry {
  /** base64 of safeStorage-encrypted JSON, when OS encryption is available. */
  enc?: string;
  /** Plaintext fallback for platforms without a keychain. */
  raw?: Credential;
}

/**
 * CredentialStore backed by an encrypted file in ~/.pi-desktop.
 * `Models` resolves every provider request through this, so both built-in and
 * custom providers authenticate the same way.
 */
export class EncryptedCredentialStore implements CredentialStore {
  private entries: Record<string, StoredEntry>;
  private chains = new Map<string, Promise<unknown>>();

  constructor() {
    this.entries = readJson<Record<string, StoredEntry>>(CREDENTIALS_FILE, {});
  }

  private persist(): void {
    writeJson(CREDENTIALS_FILE, this.entries, 0o600);
  }

  private decode(entry: StoredEntry | undefined): Credential | undefined {
    if (!entry) return undefined;
    if (entry.raw) return entry.raw;
    if (!entry.enc) return undefined;
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(entry.enc, "base64"))) as Credential;
    } catch (error) {
      console.warn("Could not decrypt credential:", error);
      return undefined;
    }
  }

  private encode(credential: Credential): StoredEntry {
    if (safeStorage.isEncryptionAvailable()) {
      return { enc: safeStorage.encryptString(JSON.stringify(credential)).toString("base64") };
    }
    return { raw: credential };
  }

  /** Serialize writes per provider so concurrent refreshes cannot interleave. */
  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.chains.set(
      providerId,
      next.catch(() => undefined),
    );
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.decode(this.entries[providerId]);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.keys(this.entries).flatMap((providerId) => {
      const credential = this.decode(this.entries[providerId]);
      return credential ? [{ providerId, type: credential.type }] : [];
    });
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const next = await fn(this.decode(this.entries[providerId]));
      if (next) this.entries[providerId] = this.encode(next);
      else delete this.entries[providerId];
      this.persist();
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(providerId, async () => {
      delete this.entries[providerId];
      this.persist();
    });
  }

  /** Convenience used by the add-model flow. */
  async setApiKey(providerId: string, key: string): Promise<void> {
    await this.modify(providerId, async () => ({ type: "api_key", key }));
  }

  hasStoredKey(providerId: string): boolean {
    return Boolean(this.entries[providerId]);
  }
}
