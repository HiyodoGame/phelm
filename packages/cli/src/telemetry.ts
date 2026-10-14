import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhelmConfig } from './config.js';

/**
 * Anonymous, opt-out CLI telemetry (T-0040): after a successful
 * `board` / `brief` / `today` run, the CLI POSTs one ping to the Helm Agent
 * server's /telemetry/ping.
 *
 * Privacy contract (README's Privacy section is the user-facing copy):
 * - the payload is EXACTLY {installId, command, version} — no project names,
 *   no repository names, no tokens, no file paths, no arguments;
 * - `installId` is a random UUID generated on first use and stored at
 *   `~/.phelm/install-id` (mode 0600); it identifies the INSTALLATION, never
 *   the user, and deleting the file resets it;
 * - telemetry is opt-out: `PHELM_NO_TELEMETRY=1` in the environment or the
 *   `--no-telemetry` flag on any of the three commands silences it entirely;
 * - every failure is silent: telemetry must never affect a command's exit
 *   code or output (the api-side ping endpoint is schema-fenced and
 *   rate-limited instead of authenticated, so there is nothing to sign in
 *   with — that is what keeps the ping anonymous).
 */

export interface CliPingPayload {
  installId: string;
  command: string;
  version: string;
}

export function installIdPath(config: PhelmConfig): string {
  return join(config.directory, 'install-id');
}

/**
 * Load the install id, generating and persisting one (0600) on first use.
 * A corrupt/empty file is regenerated rather than trusted.
 */
export function loadOrCreateInstallId(config: PhelmConfig): string {
  const path = installIdPath(config);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) {
      return existing;
    }
  }
  const created = randomUUID();
  writeFileSync(path, `${created}\n`, { mode: 0o600 });
  return created;
}

/** True when the user opted out via env or flag. Any value other than the
 * unset/empty env counts as an explicit opt-out (1/true/yes). */
export function telemetryDisabled(env: NodeJS.ProcessEnv, flag?: boolean): boolean {
  if (flag === false) {
    return true; // commander's --no-telemetry
  }
  const value = env.PHELM_NO_TELEMETRY;
  return value !== undefined && value !== '';
}

export interface SendCliPingOptions extends CliPingPayload {
  apiBaseUrl: string;
  fetch?: typeof fetch;
  /** Bounded so a hung server can never stall the command's exit. */
  timeoutMs?: number;
}

const DEFAULT_PING_TIMEOUT_MS = 2_000;

/**
 * Fire the ping. NEVER throws: every failure mode (opt-out is the caller's
 * concern, network, HTTP status, timeout) resolves silently. Awaited (not
 * floating) so the process does not exit before the request is written —
 * with the short timeout the worst case adds two quiet seconds, never an
 * error.
 */
export async function sendCliPing(options: SendCliPingOptions): Promise<void> {
  const fetchFn = options.fetch ?? fetch;
  const base = options.apiBaseUrl.replace(/\/+$/, '');
  const body: CliPingPayload = {
    installId: options.installId,
    command: options.command,
    version: options.version,
  };
  try {
    await fetchFn(`${base}/telemetry/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS),
    });
  } catch {
    // Silent by contract: telemetry must never surface to the user.
  }
}

export interface RecordCommandPingOptions {
  env: NodeJS.ProcessEnv;
  config: PhelmConfig;
  apiBaseUrl: string;
  command: string;
  version: string;
  /** commander's options.telemetry (undefined when the flag is absent). */
  flag?: boolean;
  send?: typeof sendCliPing;
}

/**
 * The one seam the commands call after a successful run: opt-out check →
 * install id → silent send. Never throws and never changes the exit code
 * (the default send never rejects; this catch also pins the invariant for
 * any future transport). An opted-out run does not even create the
 * install-id file.
 */
export async function recordCommandPing(options: RecordCommandPingOptions): Promise<void> {
  if (telemetryDisabled(options.env, options.flag)) {
    return;
  }
  const send = options.send ?? sendCliPing;
  const installId = loadOrCreateInstallId(options.config);
  try {
    await send({
      apiBaseUrl: options.apiBaseUrl,
      installId,
      command: options.command,
      version: options.version,
    });
  } catch {
    // Silent by contract: telemetry must never surface to the user.
  }
}
