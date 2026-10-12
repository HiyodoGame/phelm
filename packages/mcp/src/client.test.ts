import { describe, expect, it, vi } from 'vitest';
import {
  briefingSchema,
  HelmApiClient,
  HelmNetworkError,
  HelmNotFoundError,
  HelmServiceUnavailableError,
  HelmUnexpectedResponseError,
  HelmUnauthorizedError,
  TokenNotConfiguredError,
  boardSchema,
  gapGroupsSchema,
} from './client.js';

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const statusResponse = (status: number): Response => new Response('{}', { status });

const boardPayload = {
  generatedAt: '2026-10-12T00:00:00.000Z',
  projects: [
    {
      id: 'prj_app',
      name: 'Companion App',
      repo: 'acme/companion-app',
      goal: 'ship v2',
      stage: 'build',
      priority: 'high',
      snapshot: {
        date: '2026-10-12',
        healthScore: 72,
        factors: { ci: -10 },
        summary: 'CI red',
      },
      ci: {
        status: 'failing',
        branch: 'main',
        lastConclusion: 'failure',
        lastRunTs: '2026-10-11T10:00:00.000Z',
        failingSince: '2026-10-11T10:00:00.000Z',
        consecutiveFailures: 2,
      },
      milestones: { count: 2, averageProgress: 40, nearestDueDate: '2026-11-01' },
      risks: [{ type: 'red_ci', level: 'high', impact: 'blocked release' }],
    },
  ],
};

const relationsPayload = {
  relations: [
    {
      id: 'rel_1',
      sourceProjectId: 'prj_app',
      targetProjectId: 'prj_page',
      kind: 'app-to-product-page',
      rules: [{ signal: 'privacy_policy', enabled: true }],
      origin: 'manual',
      status: 'active',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};

const gapGroupsPayload = {
  groups: [
    {
      rootChangeId: 'rc_1',
      severity: 'high',
      firstDetectedAt: '2026-10-10T00:00:00.000Z',
      gaps: [
        {
          id: 'gap_1',
          relationId: 'rel_1',
          signal: 'privacy_policy',
          checkType: 'text_drift',
          description: 'page links the old policy',
          impact: 'stale terms',
          evidence: [
            {
              projectId: 'prj_app',
              path: 'src/legal/privacy.md',
              changedAt: '2026-10-10T00:00:00.000Z',
            },
          ],
          rootChangeId: 'rc_1',
          severity: 'high',
          status: 'open',
          detectedAt: '2026-10-10T00:00:00.000Z',
        },
      ],
    },
  ],
  total: 1,
};

const briefingPayload = {
  date: '2026-10-12',
  stats: {
    totalGaps: 1,
    relations: 1,
    maxSeverity: 'high',
    chains: 1,
    pendingDrafts: 0,
    draftRelations: 0,
  },
  contentMd: '# briefing',
};

function makeClient(
  fetchFn: typeof fetch,
  options: { token?: string; apiBaseUrl?: string } = {},
): HelmApiClient {
  return new HelmApiClient({
    apiBaseUrl: options.apiBaseUrl ?? 'http://api.test',
    token: options.token ?? 'secret-token',
    fetch: fetchFn,
  });
}

describe('HelmApiClient', () => {
  it('sends the bearer token and parses the board', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(okResponse(boardPayload));
    const client = makeClient(fetchFn);
    const board = await client.fetchBoard();
    expect(board).toEqual(boardSchema.parse(boardPayload));
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/board');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });

  it('normalizes a trailing slash on the base URL', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(okResponse(boardPayload));
    const client = makeClient(fetchFn, { apiBaseUrl: 'http://api.test///' });
    await client.fetchBoard();
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://api.test/board');
  });

  it('parses relations through the contract schema', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(okResponse(relationsPayload));
    const relations = await makeClient(fetchFn).fetchRelations();
    expect(relations).toHaveLength(1);
    expect(relations[0]?.id).toBe('rel_1');
  });

  it('fetches open gap groups with the status=open query', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(okResponse(gapGroupsPayload));
    const groups = await makeClient(fetchFn).fetchOpenGapGroups('rel_1');
    expect(groups).toEqual(gapGroupsSchema.parse(gapGroupsPayload));
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://api.test/relations/rel_1/gaps?status=open');
  });

  it('encodes the relation id in the gaps path', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(okResponse(gapGroupsPayload));
    await makeClient(fetchFn).fetchOpenGapGroups('rel one');
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://api.test/relations/rel%20one/gaps?status=open');
  });

  it('returns the latest briefing', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(okResponse(briefingPayload));
    const briefing = await makeClient(fetchFn).fetchLatestBriefing();
    expect(briefing).toEqual(briefingSchema.parse(briefingPayload));
  });

  it('maps a 404 briefing to null (no briefing generated yet)', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(statusResponse(404));
    await expect(makeClient(fetchFn).fetchLatestBriefing()).resolves.toBeNull();
  });

  it('maps 401/503/404 and other statuses to typed errors', async () => {
    const unauthorized = makeClient(vi.fn<typeof fetch>().mockResolvedValue(statusResponse(401)));
    await expect(unauthorized.fetchBoard()).rejects.toBeInstanceOf(HelmUnauthorizedError);

    const unavailable = makeClient(vi.fn<typeof fetch>().mockResolvedValue(statusResponse(503)));
    await expect(unavailable.fetchBoard()).rejects.toBeInstanceOf(HelmServiceUnavailableError);

    const missing = makeClient(vi.fn<typeof fetch>().mockResolvedValue(statusResponse(404)));
    await expect(missing.fetchBoard()).rejects.toBeInstanceOf(HelmNotFoundError);
    await expect(missing.fetchOpenGapGroups('rel_1')).rejects.toBeInstanceOf(HelmNotFoundError);

    const serverError = makeClient(vi.fn<typeof fetch>().mockResolvedValue(statusResponse(500)));
    await expect(serverError.fetchBoard()).rejects.toBeInstanceOf(HelmUnexpectedResponseError);
  });

  it('maps network failures and malformed payloads to typed errors', async () => {
    const unreachable = makeClient(
      vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    await expect(unreachable.fetchBoard()).rejects.toBeInstanceOf(HelmNetworkError);

    const badJson = makeClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('not json', { status: 200 })),
    );
    await expect(badJson.fetchBoard()).rejects.toBeInstanceOf(HelmUnexpectedResponseError);

    const wrongShape = makeClient(
      vi.fn<typeof fetch>().mockResolvedValue(okResponse({ nope: true })),
    );
    await expect(wrongShape.fetchBoard()).rejects.toBeInstanceOf(HelmUnexpectedResponseError);
  });

  it('answers a missing token with the clean token-not-configured error before any request', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = makeClient(fetchFn, { token: '' });
    await expect(client.fetchBoard()).rejects.toBeInstanceOf(TokenNotConfiguredError);
    await expect(client.fetchBoard()).rejects.toThrow(/token not configured/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
