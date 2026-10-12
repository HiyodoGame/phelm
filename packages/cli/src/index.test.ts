import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHELM_CONTRACT_VERSION } from '@phelm/contract';
import { openConfig, clearRawCredentials } from './config.js';
import { BriefingNotFoundError } from './brief.js';
import { loadStoredToken, saveStoredToken } from './crypto.js';
import { createProgram, type CliDeps } from './index.js';
import type { Briefing } from './brief.js';
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

const BRIEFING_MD = '# Daily briefing\n\nBody line.\n';
const BRIEFING: Briefing = {
  date: '2026-10-12',
  stats: {
    totalGaps: 0,
    relations: 0,
    maxSeverity: 'none',
    chains: 0,
    pendingDrafts: 0,
    draftRelations: 0,
  },
  contentMd: BRIEFING_MD,
};

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
    fetchLatestBriefing: async () => BRIEFING,
    fetchBriefingForDate: async () => BRIEFING,
    ...overrides,
  };
}

/** Capture stdout/stderr so briefing output can be asserted byte-for-byte. */
function captureStreams(): {
  out: string[];
  err: string[];
  restore: () => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map((arg) => String(arg)).join(' '));
  });
  return {
    out,
    err,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
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

  it('registers the brief and today commands', () => {
    const program = createProgram(makeDeps());
    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(['brief', 'today']));
  });

  it('shows brief and today with their descriptions in --help output', async () => {
    const help: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      help.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    // exitOverride makes commander throw instead of process.exit(0) on --help.
    const program = createProgram(makeDeps());
    program.exitOverride();
    try {
      await program.parseAsync(['--help'], { from: 'user' });
      expect.unreachable('--help should stop parsing with helpDisplayed');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('commander.helpDisplayed');
    } finally {
      outSpy.mockRestore();
    }
    // Commander wraps help text to the terminal width, so compare on
    // whitespace-normalized text.
    const text = help.join('').replace(/\s+/g, ' ');
    expect(text).toContain('brief');
    expect(text).toContain('today');
    expect(text).toContain(
      'Print the latest daily briefing (linkage gaps) from your Helm Agent server',
    );
    expect(text).toContain("Print today's briefing (UTC date; it is generated daily)");
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

describe('phelm brief', () => {
  it('prints the latest briefing verbatim to stdout and the meta line to stderr', async () => {
    const seen: Array<{ apiBaseUrl: string; token: string }> = [];
    const capture = captureStreams();
    try {
      const program = createProgram(
        makeDeps({
          fetchLatestBriefing: async (options) => {
            seen.push(options);
            return BRIEFING;
          },
        }),
      );
      await run(program, ['brief', '--api', 'http://api.example.test', '--token', 'server-token']);
    } finally {
      capture.restore();
    }
    expect(seen).toEqual([{ apiBaseUrl: 'http://api.example.test', token: 'server-token' }]);
    expect(capture.err).toEqual(['briefing for 2026-10-12']);
    // Verbatim: no prefix, no added or stripped trailing newline.
    expect(capture.out.join('')).toBe(BRIEFING_MD);
  });
});

describe('phelm today', () => {
  it('fetches the current UTC date and prints the briefing verbatim', async () => {
    const seenDates: string[] = [];
    const capture = captureStreams();
    try {
      const program = createProgram(
        makeDeps({
          fetchBriefingForDate: async (options) => {
            seenDates.push(options.date);
            return BRIEFING;
          },
        }),
      );
      await run(program, ['today']);
    } finally {
      capture.restore();
    }
    expect(seenDates).toEqual([new Date().toISOString().slice(0, 10)]);
    expect(capture.err).toEqual(['briefing for 2026-10-12']);
    expect(capture.out.join('')).toBe(BRIEFING_MD);
  });

  it('exits 1 with a hint on 404 and never falls back to the latest briefing', async () => {
    const capture = captureStreams();
    let exitCode: typeof process.exitCode;
    try {
      const program = createProgram(
        makeDeps({
          fetchBriefingForDate: async () => {
            throw new BriefingNotFoundError('2026-10-12');
          },
        }),
      );
      await run(program, ['today']);
      exitCode = process.exitCode;
    } finally {
      capture.restore();
      process.exitCode = 0;
    }
    expect(exitCode).toBe(1);
    expect(capture.err).toEqual([
      'no briefing generated for today yet (it is generated daily; try `phelm brief` for the latest)',
    ]);
    expect(capture.out).toEqual([]);
  });
});
