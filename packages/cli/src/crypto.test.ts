import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openConfig } from './config.js';
import {
  decryptString,
  encryptString,
  loadOrCreateKey,
  loadStoredToken,
  saveStoredToken,
} from './crypto.js';

const testHome = mkdtempSync(join(tmpdir(), 'phelm-cli-crypto-'));
const env = { PHELM_HOME: testHome } satisfies NodeJS.ProcessEnv;

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe('credential encryption', () => {
  it('round-trips a token through AES-256-GCM', () => {
    const key = loadOrCreateKey(openConfig(env));
    const payload = encryptString('ghu_secret-token-value', key);

    expect(payload.data).not.toContain('ghu_secret-token-value');
    expect(decryptString(payload, key)).toBe('ghu_secret-token-value');
  });

  it('uses a fresh IV per call', () => {
    const key = loadOrCreateKey(openConfig(env));
    const first = encryptString('same plaintext', key);
    const second = encryptString('same plaintext', key);
    expect(first.iv).not.toBe(second.iv);
  });

  it('fails on a tampered ciphertext (GCM auth tag)', () => {
    const key = loadOrCreateKey(openConfig(env));
    const payload = encryptString('ghu_secret-token-value', key);
    expect(() =>
      decryptString({ ...payload, data: Buffer.from('tampered').toString('base64') }, key),
    ).toThrow();
  });

  it('stores and reloads the token through the config directory', () => {
    const config = openConfig(env);
    saveStoredToken(config, 'ghu_round-trip-token');
    expect(loadStoredToken(config)).toBe('ghu_round-trip-token');
  });

  it('reports undefined before any login', () => {
    const otherHome = mkdtempSync(join(tmpdir(), 'phelm-cli-crypto-fresh-'));
    try {
      const config = openConfig({ PHELM_HOME: otherHome } satisfies NodeJS.ProcessEnv);
      expect(loadStoredToken(config)).toBeUndefined();
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it('creates the key file with owner-only permissions', () => {
    const config = openConfig(env);
    loadOrCreateKey(config);
    const mode = statSync(join(config.directory, 'key')).mode;
    // POSIX check only: Windows does not model the group/other bits.
    if (process.platform !== 'win32') {
      expect(mode & 0o077).toBe(0);
    }
  });
});
