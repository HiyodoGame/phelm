import { mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { openConfig } from './config.js';
import {
  installIdPath,
  loadOrCreateInstallId,
  recordCommandPing,
  sendCliPing,
  telemetryDisabled,
  type SendCliPingOptions,
} from './telemetry.js';

/**
 * Anonymous CLI telemetry (T-0040): the payload is installId/command/version
 * ONLY (asserted key-exactly — no project data, no token), the install id is
 * a 0600-persisted random UUID reused across runs, opt-out works via env and
 * flag (and creates nothing), and every failure is silent — telemetry can
 * never touch a command's exit code or output.
 */

const testHome = mkdtempSync(join(tmpdir(), 'phelm-cli-telemetry-'));
const env = {} satisfies NodeJS.ProcessEnv;
const config = openConfig({ PHELM_HOME: testHome } satisfies NodeJS.ProcessEnv);

afterEach(() => {
  rmSync(installIdPath(config), { force: true });
});

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe('loadOrCreateInstallId', () => {
  it('generates a UUID on first use and persists it (0600 POSIX bits)', () => {
    const first = loadOrCreateInstallId(config);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(readFileSync(installIdPath(config), 'utf8').trim()).toBe(first);
    // POSIX check only: Windows does not model the group/other bits
    // (crypto.test.ts precedent for the credentials file).
    const mode = statSync(installIdPath(config)).mode;
    if (process.platform !== 'win32') {
      expect(mode & 0o077).toBe(0);
    }
  });

  it('reuses the persisted id across runs (one id per installation)', () => {
    const first = loadOrCreateInstallId(config);
    expect(loadOrCreateInstallId(config)).toBe(first);
  });

  it('regenerates instead of trusting a corrupt file', () => {
    writeFileSync(installIdPath(config), 'not-a-uuid\n');
    const regenerated = loadOrCreateInstallId(config);
    expect(regenerated).toMatch(/^[0-9a-f-]{36}$/i);
    expect(regenerated).not.toBe('not-a-uuid');
  });
});

describe('telemetryDisabled', () => {
  it('is on by default (no env, no flag)', () => {
    expect(telemetryDisabled({})).toBe(false);
    expect(telemetryDisabled({}, true)).toBe(false);
  });

  it('honours PHELM_NO_TELEMETRY and the --no-telemetry flag', () => {
    expect(telemetryDisabled({ PHELM_NO_TELEMETRY: '1' })).toBe(true);
    expect(telemetryDisabled({ PHELM_NO_TELEMETRY: 'true' })).toBe(true);
    expect(telemetryDisabled({ PHELM_NO_TELEMETRY: '' })).toBe(false);
    // commander's --no-telemetry arrives as options.telemetry === false.
    expect(telemetryDisabled({}, false)).toBe(true);
    // There is no re-enable: an absent flag never overrides a disabled env.
    expect(telemetryDisabled({ PHELM_NO_TELEMETRY: '1' }, true)).toBe(true);
  });
});

describe('sendCliPing', () => {
  it('POSTs EXACTLY {installId, command, version} — no project data, no token', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 201 }));
    await sendCliPing({
      apiBaseUrl: 'http://api.test/',
      installId: '11111111-1111-4111-8111-111111111111',
      command: 'board',
      version: '0.0.4',
      fetch: fetchFn as unknown as typeof fetch,
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/telemetry/ping');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['command', 'installId', 'version']);
    expect(body).toEqual({
      installId: '11111111-1111-4111-8111-111111111111',
      command: 'board',
      version: '0.0.4',
    });
  });

  it('is silent on network errors and on any HTTP status', async () => {
    const failing = vi.fn(async () => {
      throw new Error('connection refused');
    });
    await expect(
      sendCliPing({
        apiBaseUrl: 'http://api.test',
        installId: 'x',
        command: 'board',
        version: '0.0.4',
        fetch: failing as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
    const serverError = vi.fn(async () => new Response('{}', { status: 500 }));
    await expect(
      sendCliPing({
        apiBaseUrl: 'http://api.test',
        installId: 'x',
        command: 'board',
        version: '0.0.4',
        fetch: serverError as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('recordCommandPing', () => {
  const BASE = {
    config,
    apiBaseUrl: 'http://api.test',
    command: 'board',
    version: '0.0.4',
  } as const;

  it('sends one ping with the persisted install id after a successful run', async () => {
    const send = vi.fn(async (_options: SendCliPingOptions) => undefined);
    await recordCommandPing({ ...BASE, env, send });
    expect(send).toHaveBeenCalledTimes(1);
    const options = send.mock.calls[0]![0]!;
    expect(options.command).toBe('board');
    expect(options.version).toBe('0.0.4');
    expect(options.apiBaseUrl).toBe('http://api.test');
    expect(options.installId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(existsSync(installIdPath(config))).toBe(true);
  });

  it('PHELM_NO_TELEMETRY=1 opts out entirely — no send, no install-id file', async () => {
    const send = vi.fn(async (_options: SendCliPingOptions) => undefined);
    await recordCommandPing({ ...BASE, env: { PHELM_NO_TELEMETRY: '1' }, send });
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(installIdPath(config))).toBe(false);
  });

  it('--no-telemetry (flag false) opts out entirely', async () => {
    const send = vi.fn(async (_options: SendCliPingOptions) => undefined);
    await recordCommandPing({ ...BASE, env, flag: false, send });
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(installIdPath(config))).toBe(false);
  });

  it('a rejecting send never propagates (exit code stays clean)', async () => {
    const send = vi.fn(async () => {
      throw new Error('transport exploded');
    });
    await expect(recordCommandPing({ ...BASE, env, send })).resolves.toBeUndefined();
  });
});
