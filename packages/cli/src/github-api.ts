/**
 * Minimal GitHub REST calls for the phelm CLI (T-0009).
 *
 * Deliberately tiny and independent: phelm is a public, standalone CLI and
 * must not depend on any server-side package. Response bodies parse
 * leniently (zod is not pulled in just for this).
 */

import { warnCleartextApiUrl } from './board.js';

export interface UserRepo {
  fullName: string;
  private: boolean;
  pushedAt: string;
  language: string | null;
  defaultBranch: string;
}

interface RestRepo {
  full_name: string;
  private: boolean;
  pushed_at: string;
  language: string | null;
  default_branch: string;
}

export class GitHubApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

async function assertOk(response: Response, what: string): Promise<void> {
  if (!response.ok) {
    throw new GitHubApiError(`${what} failed with status ${response.status}`);
  }
}

/**
 * List the authenticated user's own repositories, most recently pushed
 * first. Uses the same API surface as the `gh` CLI (`affiliation=owner`).
 */
export async function listUserRepos(
  token: string,
  deps: { fetch?: typeof fetch } = {},
): Promise<UserRepo[]> {
  const fetchFn = deps.fetch ?? fetch;
  const response = await fetchFn(
    'https://api.github.com/user/repos?per_page=100&affiliation=owner&sort=pushed',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'phelm-cli',
      },
    },
  );
  await assertOk(response, 'listing repositories');
  const repos = (await response.json()) as Partial<RestRepo>[];
  return repos
    .filter((repo) => typeof repo.full_name === 'string')
    .map((repo) => ({
      fullName: repo.full_name as string,
      private: repo.private === true,
      pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : '',
      language: typeof repo.language === 'string' ? repo.language : null,
      defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : '',
    }));
}

export interface ImportResult {
  projectId: string;
  repo: string;
  name: string;
}

/**
 * Ask the Helm Agent server to start tracking one repository.
 * The server's response is a ProjectCharter; only the fields the CLI
 * prints are extracted here.
 */
export async function importRepoOnServer(options: {
  apiBaseUrl: string;
  token: string;
  repo: string;
  fetch?: typeof fetch;
}): Promise<ImportResult> {
  const fetchFn = options.fetch ?? fetch;
  const base = options.apiBaseUrl.replace(/\/+$/, '');
  warnCleartextApiUrl(base);
  let response: Response;
  try {
    response = await fetchFn(`${base}/projects/from-repo`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ repo: options.repo }),
      // Same-origin redirects must not replay the token (review P2 hardening).
      // Only the HELM-server call here — the GitHub REST fetch above keeps
      // its default redirect behaviour (GitHub legitimately redirects, and
      // cross-origin redirects strip Authorization per the fetch spec).
      redirect: 'error',
    });
  } catch {
    throw new GitHubApiError(`cannot reach the Helm Agent server at ${base} (is it running?)`);
  }
  if (response.status === 409) {
    throw new GitHubApiError(`${options.repo} is already tracked by the server`);
  }
  if (response.status === 401) {
    throw new GitHubApiError('the server rejected the API token (check --token / PHELM_API_TOKEN)');
  }
  await assertOk(response, `importing ${options.repo}`);
  const charter = (await response.json()) as { id?: string; repo?: string; name?: string };
  if (
    typeof charter.id !== 'string' ||
    typeof charter.repo !== 'string' ||
    typeof charter.name !== 'string'
  ) {
    throw new GitHubApiError('the server returned an unexpected response body');
  }
  return { projectId: charter.id, repo: charter.repo, name: charter.name };
}
