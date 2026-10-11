import { describe, expect, it } from 'vitest';
import { GitHubApiError, importRepoOnServer, listUserRepos } from './github-api.js';

/** Scripted GitHub/server responses; no network, no real tokens. */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('listUserRepos', () => {
  it('maps the REST payload onto UserRepo rows with auth headers', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        jsonResponse([
          {
            full_name: 'octo/one',
            private: true,
            pushed_at: '2026-10-09T00:00:00Z',
            language: 'TypeScript',
            default_branch: 'main',
          },
          {
            full_name: 'octo/two',
            private: false,
            pushed_at: '2026-10-10T00:00:00Z',
            language: null,
            default_branch: 'master',
          },
        ]),
      );
    };

    const repos = await listUserRepos('ghu_test', { fetch: fetchFn });

    expect(repos).toEqual([
      {
        fullName: 'octo/one',
        private: true,
        pushedAt: '2026-10-09T00:00:00Z',
        language: 'TypeScript',
        defaultBranch: 'main',
      },
      {
        fullName: 'octo/two',
        private: false,
        pushedAt: '2026-10-10T00:00:00Z',
        language: null,
        defaultBranch: 'master',
      },
    ]);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer ghu_test');
    expect(calls[0]?.url).toContain('affiliation=owner');
  });

  it('surfaces a non-OK listing status', async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(jsonResponse({ message: 'Bad credentials' }, 401));
    await expect(listUserRepos('bad-token', { fetch: fetchFn })).rejects.toThrow(/status 401/);
  });
});

describe('importRepoOnServer', () => {
  const baseOptions = {
    apiBaseUrl: 'http://localhost:3000/',
    token: 'server-token',
    repo: 'octo/one',
  };

  it('POSTs the repo with the bearer token and maps the charter response', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        jsonResponse({
          id: 'prj_123',
          repo: 'octo/one',
          name: 'one',
          goal: 'draft',
          stage: 'developing',
          priority: 'P2',
          cadence: 3,
          constraints: [],
          agents: [],
        }),
      );
    };

    const result = await importRepoOnServer({ ...baseOptions, fetch: fetchFn });

    expect(result).toEqual({ projectId: 'prj_123', repo: 'octo/one', name: 'one' });
    expect(calls[0]?.url).toBe('http://localhost:3000/projects/from-repo');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer server-token');
    expect(String(calls[0]?.init?.body)).toBe(JSON.stringify({ repo: 'octo/one' }));
  });

  it('maps duplicate imports (409), rejected tokens (401) and unreachable servers', async () => {
    const conflict: typeof fetch = () => Promise.resolve(jsonResponse({}, 409));
    await expect(importRepoOnServer({ ...baseOptions, fetch: conflict })).rejects.toThrow(
      /already tracked/,
    );

    const rejected: typeof fetch = () => Promise.resolve(jsonResponse({}, 401));
    await expect(importRepoOnServer({ ...baseOptions, fetch: rejected })).rejects.toThrow(
      /rejected the API token/,
    );

    const unreachable: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await expect(importRepoOnServer({ ...baseOptions, fetch: unreachable })).rejects.toThrow(
      /cannot reach/,
    );
  });

  it('rejects an unexpected response body', async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(jsonResponse({ unexpected: true }));
    await expect(importRepoOnServer({ ...baseOptions, fetch: fetchFn })).rejects.toThrow(
      GitHubApiError,
    );
  });
});
