import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PHELM_CONTRACT_VERSION } from '@phelm/contract';
import { openConfig, clearRawCredentials } from './config.js';
import { loadStoredToken, saveStoredToken } from './crypto.js';
import { createProgram, type CliDeps } from './index.js';
import type { ImportResult, UserRepo } from './github-api.js';

/**
 * Command wiring is tested through createProgram with injected deps and a
 * PHELM_HOME sandbox, so nothing here touches the network or the real
 * ~/.phelm. Parsing is driven via program.parseAsync with explicit argv.
 */

const testHome = mkdtempSync(join(tmpdir(), 'phelm-cli-index-'));
const env = { PHELM_HOME: testHome } satisfies NodeJS.ProcessEnv;

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

beforeEach(() => {
  clearRawCredentials(openConfig(env));
});

function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    env,
    deviceFlow: async () => 'ghu_injected-token',
    listRepos: async () =>
      [
        {
          fullName: 'octo/one',
          private: true,
          pushedAt: '2026-10-09T00:00:00Z',
          language: 'TypeScript',
          defaultBranch: 'main',
        },
      ] satisfies UserRepo[],
    importRepo: async (): Promise<ImportResult> => ({
      projectId: 'prj_injected',
      repo: 'octo/one',
      name: 'one',
    }),
    ...overrides,
  };
}

function run(program: ReturnType<typeof createProgram>, args: string[]): Promise<unknown> {
  return program.parseAsync(args, { from: 'user' });
}

describe('phelm cli', () => {
  it('builds a program with the expected name', () => {
    const program = createProgram(makeDeps());
    expect(program.name()).toBe('phelm');
  });

  it('reports a non-empty version taken from the contract', () => {
    const program = createProgram(makeDeps());
    expect(program.version()).toBe(PHELM_CONTRACT_VERSION);
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('registers the placeholder board command', () => {
    const program = createProgram(makeDeps());
    const board = program.commands.find((command) => command.name() === 'board');
    expect(board).toBeDefined();
  });

  it('registers login, logout and repos commands', () => {
    const program = createProgram(makeDeps());
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(['login', 'logout', 'repos']));
  });
});

describe('phelm login', () => {
  it('stores the token from the device flow (encrypted at rest)', async () => {
    const program = createProgram(makeDeps());
    await run(program, ['login', '--client-id', 'cli-client-id']);

    const stored = loadStoredToken(openConfig(env));
    expect(stored).toBe('ghu_injected-token');
  });

  it('wires the client id from the flag, env, or passes an empty string (validated in loginWithDeviceFlow)', async () => {
    const seenClientIds: string[] = [];
    const recordingFlow = async (clientId: string): Promise<string> => {
      seenClientIds.push(clientId);
      return 'ghu_injected-token';
    };

    const fromFlag = createProgram(makeDeps({ deviceFlow: recordingFlow }));
    await run(fromFlag, ['login', '--client-id', 'flag-client-id']);
    expect(seenClientIds).toEqual(['flag-client-id']);

    const fromEnv = createProgram(
      makeDeps({
        env: { PHELM_HOME: testHome, PHELM_CLIENT_ID: 'env-client-id' },
        deviceFlow: recordingFlow,
      }),
    );
    await run(fromEnv, ['login']);
    expect(seenClientIds).toEqual(['flag-client-id', 'env-client-id']);

    const empty = createProgram(makeDeps({ deviceFlow: recordingFlow }));
    await run(empty, ['login']);
    expect(seenClientIds).toEqual(['flag-client-id', 'env-client-id', '']);
  });
});

describe('phelm logout', () => {
  it('clears stored credentials', async () => {
    saveStoredToken(openConfig(env), 'ghu_injected-token');
    const program = createProgram(makeDeps());
    await run(program, ['logout']);
    expect(loadStoredToken(openConfig(env))).toBeUndefined();
  });
});

describe('phelm repos', () => {
  it('lists repositories with the stored token', async () => {
    saveStoredToken(openConfig(env), 'ghu_injected-token');
    const seenTokens: string[] = [];
    const program = createProgram(
      makeDeps({
        listRepos: async (token) => {
          seenTokens.push(token);
          return [
            {
              fullName: 'octo/one',
              private: true,
              pushedAt: '2026-10-09T00:00:00Z',
              language: 'TypeScript',
              defaultBranch: 'main',
            },
          ];
        },
      }),
    );
    await run(program, ['repos']);

    expect(seenTokens).toEqual(['ghu_injected-token']);
  });

  it('exits non-zero with a hint when not signed in', async () => {
    const program = createProgram(makeDeps());
    await run(program, ['repos']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('import posts to the configured server and reports the project', async () => {
    const seenOptions: Array<{ apiBaseUrl: string; token: string; repo: string }> = [];
    const program = createProgram(
      makeDeps({
        importRepo: async (options) => {
          seenOptions.push(options);
          return { projectId: 'prj_injected', repo: options.repo, name: 'one' };
        },
      }),
    );
    await run(program, [
      'repos',
      'import',
      'octo/one',
      '--api',
      'http://api.example.test',
      '--token',
      'server-token',
    ]);

    expect(seenOptions).toEqual([
      { apiBaseUrl: 'http://api.example.test', token: 'server-token', repo: 'octo/one' },
    ]);
  });
});
