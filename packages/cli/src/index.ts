#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { PHELM_CONTRACT_VERSION } from '@phelm/contract';
import { clearRawCredentials, openConfig } from './config.js';
import { loadStoredToken, saveStoredToken } from './crypto.js';
import { loginWithDeviceFlow } from './device-flow.js';
import {
  importRepoOnServer,
  listUserRepos,
  type ImportResult,
  type UserRepo,
} from './github-api.js';

/**
 * The phelm CLI (T-0009): `login` (GitHub device flow, encrypted local
 * token), `logout`, and `repos` (list with the user token, import to the
 * Helm Agent server). Credentials never appear in logs or error messages.
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

  const program = new Command();

  program
    .name('phelm')
    .description('Task board tracker for ProjectHelm')
    .version(PHELM_CONTRACT_VERSION);

  program
    .command('board')
    .description('Show the current task board')
    .action(() => {
      console.log('not implemented yet');
    });

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
  createProgram().parse();
}
