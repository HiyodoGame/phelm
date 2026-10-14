#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { PHELM_CONTRACT_VERSION } from '@phelm/contract';
import { clearRawCredentials, openConfig } from './config.js';
import { fetchBoard, renderBoard } from './board.js';
import {
  BriefingNotFoundError,
  fetchBriefingForDate as fetchBriefingForDateFromServer,
  fetchLatestBriefing as fetchLatestBriefingFromServer,
  printBriefing,
  utcToday,
  type Briefing,
} from './brief.js';
import { loadStoredToken, saveStoredToken } from './crypto.js';
import { loginWithDeviceFlow } from './device-flow.js';
import {
  importRepoOnServer,
  listUserRepos,
  type ImportResult,
  type UserRepo,
} from './github-api.js';
import { parseIntervalSeconds, runRunner, type RunnerOptions } from './runner.js';
import { recordCommandPing, type SendCliPingOptions } from './telemetry.js';

/**
 * The phelm CLI (T-0009): `login` (GitHub device flow, encrypted local
 * token), `logout`, and `repos` (list with the user token, import to the
 * Helm Agent server). Credentials never appear in logs or error messages.
 * T-0040: `board` / `brief` / `today` additionally fire one anonymous,
 * opt-out telemetry ping after a successful run (see telemetry.ts and the
 * README's Privacy section).
 */

const DEFAULT_API_BASE = 'http://localhost:3000';

export interface CliDeps {
  /** Environment the CLI reads (flags > env > defaults). Tests inject. */
  env?: NodeJS.ProcessEnv;
  deviceFlow?: (clientId: string) => Promise<string>;
  listRepos?: (token: string) => Promise<UserRepo[]>;
  importRepo?: (options: {
    apiBaseUrl: string;
    token: string;
    repo: string;
  }) => Promise<ImportResult>;
  fetchLatestBriefing?: (options: { apiBaseUrl: string; token: string }) => Promise<Briefing>;
  fetchBriefingForDate?: (options: {
    apiBaseUrl: string;
    token: string;
    date: string;
  }) => Promise<Briefing>;
  /** The whole runner loop (T-0038); tests inject to observe the wiring. */
  runner?: (options: RunnerOptions) => Promise<void>;
  /** The anonymous telemetry ping (T-0040); tests inject to observe it. */
  sendPing?: (options: SendCliPingOptions) => Promise<void>;
}

/** Build the phelm commander program. Exported so tests can drive it. */
export function createProgram(deps: CliDeps = {}): Command {
  const env = deps.env ?? process.env;
  const config = openConfig(env);
  const deviceFlow = deps.deviceFlow ?? ((clientId: string) => loginWithDeviceFlow(clientId));
  const listRepos = deps.listRepos ?? ((token: string) => listUserRepos(token));
  const importRepo =
    deps.importRepo ??
    ((options: { apiBaseUrl: string; token: string; repo: string }) => importRepoOnServer(options));
  const fetchLatestBriefing =
    deps.fetchLatestBriefing ??
    ((options: { apiBaseUrl: string; token: string }) => fetchLatestBriefingFromServer(options));
  const fetchBriefingForDate =
    deps.fetchBriefingForDate ??
    ((options: { apiBaseUrl: string; token: string; date: string }) =>
      fetchBriefingForDateFromServer(options));
  const runnerLoop =
    deps.runner ??
    ((options: RunnerOptions) =>
      runRunner(options).then((result) => {
        if (!result.ok) {
          process.exitCode = 1;
        }
      }));

  /**
   * The T-0040 ping seam: called after a SUCCESSFUL board/brief/today run.
   * Opt-out via --no-telemetry (flag === false) or PHELM_NO_TELEMETRY; every
   * failure inside is silent and cannot touch the exit code.
   */
  const ping = (command: string, apiBaseUrl: string, telemetry?: boolean): Promise<void> =>
    recordCommandPing({
      env,
      config,
      apiBaseUrl,
      command,
      version: PHELM_CONTRACT_VERSION,
      flag: telemetry,
      ...(deps.sendPing === undefined ? {} : { send: deps.sendPing }),
    });

  const program = new Command();

  program
    .name('phelm')
    .description('Task board tracker for ProjectHelm')
    .version(PHELM_CONTRACT_VERSION);

  program
    .command('board')
    .description('Show the board from your Helm Agent server (health, CI, milestones)')
    .option('--api <url>', 'Helm Agent API base URL', env.PHELM_API_BASE ?? DEFAULT_API_BASE)
    .option(
      '--token <token>',
      'Helm Agent API token (or set PHELM_API_TOKEN)',
      env.PHELM_API_TOKEN ?? '',
    )
    .option('--json', 'Print the raw board JSON')
    .option('--no-telemetry', 'Skip the anonymous usage ping for this run')
    .action(
      async (options: { api: string; token: string; json?: boolean; telemetry?: boolean }) => {
        const board = await fetchBoard({ apiBaseUrl: options.api, token: options.token });
        if (options.json === true) {
          console.log(JSON.stringify(board, null, 2));
        } else {
          const colors = process.stdout.isTTY === true && env.NO_COLOR === undefined;
          console.log(renderBoard(board, { colors }));
        }
        await ping('board', options.api, options.telemetry);
      },
    );

  program
    .command('brief')
    .description('Print the latest daily briefing (linkage gaps) from your Helm Agent server')
    .option('--api <url>', 'Helm Agent API base URL', env.PHELM_API_BASE ?? DEFAULT_API_BASE)
    .option(
      '--token <token>',
      'Helm Agent API token (or set PHELM_API_TOKEN)',
      env.PHELM_API_TOKEN ?? '',
    )
    .option('--no-telemetry', 'Skip the anonymous usage ping for this run')
    .action(async (options: { api: string; token: string; telemetry?: boolean }) => {
      const briefing = await fetchLatestBriefing({ apiBaseUrl: options.api, token: options.token });
      printBriefing(briefing, {
        out: (text) => process.stdout.write(text),
        err: (text) => console.error(text),
      });
      await ping('brief', options.api, options.telemetry);
    });

  program
    .command('today')
    .description("Print today's briefing (UTC date; it is generated daily)")
    .option('--api <url>', 'Helm Agent API base URL', env.PHELM_API_BASE ?? DEFAULT_API_BASE)
    .option(
      '--token <token>',
      'Helm Agent API token (or set PHELM_API_TOKEN)',
      env.PHELM_API_TOKEN ?? '',
    )
    .option('--no-telemetry', 'Skip the anonymous usage ping for this run')
    .action(async (options: { api: string; token: string; telemetry?: boolean }) => {
      try {
        const briefing = await fetchBriefingForDate({
          apiBaseUrl: options.api,
          token: options.token,
          date: utcToday(),
        });
        printBriefing(briefing, {
          out: (text) => process.stdout.write(text),
          err: (text) => console.error(text),
        });
        await ping('today', options.api, options.telemetry);
      } catch (error) {
        if (error instanceof BriefingNotFoundError) {
          // Expected state, not a crash: today's briefing may not exist yet.
          // No silent fallback to the latest one — `today` stays deterministic.
          // A failed run fires no telemetry (only successes count).
          console.error(
            'no briefing generated for today yet (it is generated daily; try `phelm brief` for the latest)',
          );
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });

  program
    .command('runner')
    .description(
      'Claim tasks from your Helm Agent server, run your local agent CLI headless on each, and report back (polling loop; Ctrl+C stops after the current cycle)',
    )
    .option('--api <url>', 'Helm Agent API base URL', env.PHELM_API_BASE ?? DEFAULT_API_BASE)
    .option(
      '--token <token>',
      'Helm Agent API token (or set PHELM_API_TOKEN)',
      env.PHELM_API_TOKEN ?? '',
    )
    .option(
      '--agent <template>',
      'Shell command template that runs your agent headless; the task prompt is piped to its stdin (or set PHELM_RUNNER_AGENT)',
      env.PHELM_RUNNER_AGENT ?? '',
    )
    .option('--interval <seconds>', 'Seconds between claim attempts', '30')
    .option('--once', 'Run a single claim cycle, then exit', false)
    .action(
      async (options: {
        api: string;
        token: string;
        agent: string;
        interval: string;
        once?: boolean;
      }) => {
        const intervalSeconds = parseIntervalSeconds(options.interval);
        if (intervalSeconds === undefined) {
          console.error(
            `phelm runner: --interval must be a positive integer of seconds (got "${options.interval}")`,
          );
          process.exitCode = 1;
          return;
        }
        if (options.agent === '') {
          console.error(
            'phelm runner: missing --agent <template> (or set PHELM_RUNNER_AGENT).\n' +
              'Usage: phelm runner --agent "<agent command template>" --api <url> --token <token> [--interval <seconds>] [--once]',
          );
          process.exitCode = 1;
          return;
        }
        await runnerLoop({
          apiBaseUrl: options.api,
          token: options.token,
          agentTemplate: options.agent,
          intervalSeconds,
          once: options.once === true,
        });
      },
    );

  program
    .command('login')
    .description('Sign in with GitHub (OAuth device flow; token stored encrypted)')
    .requiredOption(
      '--client-id <id>',
      'GitHub App client id (or set PHELM_CLIENT_ID)',
      env.PHELM_CLIENT_ID ?? '',
    )
    .action(async (options: { clientId: string }) => {
      const token = await deviceFlow(options.clientId);
      saveStoredToken(config, token);
      console.log('Signed in. The token is stored encrypted locally.');
    });

  program
    .command('logout')
    .description('Remove the stored GitHub token')
    .action(() => {
      if (clearRawCredentials(config)) {
        console.log('Signed out.');
      } else {
        console.log('Not signed in.');
      }
    });

  const repos = program
    .command('repos')
    .description('List your GitHub repositories (use "repos import" to start tracking one)')
    .option('--json', 'Print the list as JSON')
    .action(async (options: { json?: boolean }) => {
      const token = loadStoredToken(config);
      if (token === undefined) {
        console.error('Not signed in. Run: phelm login');
        process.exitCode = 1;
        return;
      }
      const repoList = await listRepos(token);
      if (options.json === true) {
        console.log(JSON.stringify(repoList, null, 2));
        return;
      }
      for (const repo of repoList) {
        const flags = `${repo.private ? 'private' : 'public'}${repo.language === null ? '' : `  ${repo.language}`}`;
        console.log(`${repo.pushedAt.padEnd(22)}${repo.fullName.padEnd(40)}${flags}`);
      }
    });

  repos
    .command('import <owner/name>')
    .description('Ask the Helm Agent server to start tracking a repository')
    .option('--api <url>', 'Helm Agent API base URL', env.PHELM_API_BASE ?? DEFAULT_API_BASE)
    .option(
      '--token <token>',
      'Helm Agent API token (or set PHELM_API_TOKEN)',
      env.PHELM_API_TOKEN ?? '',
    )
    .action(async (repo: string, options: { api: string; token: string }) => {
      const result = await importRepo({ apiBaseUrl: options.api, token: options.token, repo });
      console.log(`Tracking ${result.repo} as project ${result.name} (${result.projectId}).`);
    });

  return program;
}

// npm installs bin targets through symlinks: resolve argv[1] through its
// real path before comparing with import.meta.url, or the check fails and
// the CLI silently does nothing when invoked as `phelm`.
const entryPoint = process.argv[1];
const isDirectRun =
  Boolean(entryPoint) && import.meta.url === pathToFileURL(realpathSync(entryPoint as string)).href;

if (isDirectRun) {
  // Async command errors surface here: print the message, not a stack, and
  // exit non-zero (401/409/network failures are user-actionable states).
  createProgram()
    .parseAsync()
    .catch((error: unknown) => {
      console.error(`phelm: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
