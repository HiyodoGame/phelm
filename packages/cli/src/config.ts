import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Filesystem layout for the phelm CLI (T-0009).
 *
 * Everything lives under one config directory (default `~/.phelm`):
 *
 *   ~/.phelm/key           - 32-byte local key used to encrypt credentials
 *   ~/.phelm/credentials   - encrypted GitHub user access token (JSON)
 *
 * PHELM_HOME overrides the directory (used by tests and sandboxes).
 */

export interface PhelmConfig {
  readonly directory: string;
}

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PHELM_HOME;
  return override !== undefined && override !== '' ? override : join(homedir(), '.phelm');
}

export function keyPath(config: PhelmConfig): string {
  return join(config.directory, 'key');
}

export function credentialsPath(config: PhelmConfig): string {
  return join(config.directory, 'credentials');
}

export function openConfig(env: NodeJS.ProcessEnv = process.env): PhelmConfig {
  const directory = configDirectory(env);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return { directory };
}

/** Load the raw credentials file; undefined when never written. */
export function readRawCredentials(config: PhelmConfig): string | undefined {
  const path = credentialsPath(config);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** Persist the (already encrypted) credentials payload. */
export function writeRawCredentials(config: PhelmConfig, payload: string): void {
  writeFileSync(credentialsPath(config), payload, { mode: 0o600 });
}

/** Remove stored credentials; returns false when there was nothing to remove. */
export function clearRawCredentials(config: PhelmConfig): boolean {
  const path = credentialsPath(config);
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path);
  return true;
}
