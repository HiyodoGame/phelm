import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { keyPath, readRawCredentials, writeRawCredentials, type PhelmConfig } from './config.js';

/**
 * Local credential encryption (T-0009): AES-256-GCM with a random key file.
 *
 * Threat model, stated honestly: the key lives next to the ciphertext on the
 * same machine, so this protects against casual scraping of dotfiles,
 * backups and shared home directories — NOT against a fully compromised
 * machine. That matches how far a zero-dependency, cross-platform CLI can
 * go without OS keychain integration, which is tracked as follow-up work.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Load the local key, creating a fresh random one (mode 0600) if absent. */
export function loadOrCreateKey(config: PhelmConfig): Buffer {
  const path = keyPath(config);
  if (!existsSync(path)) {
    const key = randomBytes(KEY_BYTES);
    writeFileSync(path, key, { mode: 0o600 });
    return key;
  }
  const key = readFileSync(path);
  if (key.length !== KEY_BYTES) {
    throw new Error(`credential key file has an unexpected size: ${key.length} bytes`);
  }
  return key;
}

/** Envelope format written to the credentials file. */
export interface EncryptedPayload {
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

/** Encrypt one secret with AES-256-GCM; fresh IV every call. */
export function encryptString(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

/** Decrypt an envelope; throws when the key or tag does not match. */
export function decryptString(payload: EncryptedPayload, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/** Persist the GitHub user access token, encrypted with the local key. */
export function saveStoredToken(config: PhelmConfig, token: string): void {
  const key = loadOrCreateKey(config);
  writeRawCredentials(config, JSON.stringify(encryptString(token, key)));
}

/**
 * Read + decrypt the stored GitHub token; undefined when not logged in.
 * Never logs the token or the key.
 */
export function loadStoredToken(config: PhelmConfig): string | undefined {
  const raw = readRawCredentials(config);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const payload = JSON.parse(raw) as EncryptedPayload;
  return decryptString(payload, loadOrCreateKey(config));
}
