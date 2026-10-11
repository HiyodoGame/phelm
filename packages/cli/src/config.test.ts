import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  clearRawCredentials,
  configDirectory,
  credentialsPath,
  openConfig,
  readRawCredentials,
  writeRawCredentials,
} from './config.js';

/** PHELM_HOME isolates every test from the developer's real ~/.phelm. */

const testHome = mkdtempSync(join(tmpdir(), 'phelm-cli-config-'));
const env = { PHELM_HOME: testHome } satisfies NodeJS.ProcessEnv;

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe('config layout', () => {
  it('honours PHELM_HOME over the home directory default', () => {
    expect(configDirectory(env)).toBe(testHome);
  });

  it('falls back to ~/.phelm without the override', () => {
    expect(configDirectory({} satisfies NodeJS.ProcessEnv)).toBe(join(homedir(), '.phelm'));
  });

  it('opens (creates) the config directory and stores credentials inside it', () => {
    const config = openConfig(env);
    expect(config.directory).toBe(testHome);
    expect(credentialsPath(config)).toBe(join(testHome, 'credentials'));

    expect(readRawCredentials(config)).toBeUndefined();
    writeRawCredentials(config, 'payload');
    expect(readRawCredentials(config)).toBe('payload');

    expect(clearRawCredentials(config)).toBe(true);
    expect(readRawCredentials(config)).toBeUndefined();
    expect(clearRawCredentials(config)).toBe(false);
  });
});
