import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HelmNetworkError,
  type Board,
  type GapGroups,
  type HelmApi,
  type LinkageGap,
} from './client.js';
import { TokenNotConfiguredError } from './client.js';
import { createPhelmMcpServer } from './server.js';

/**
 * Tool behavior tests (T-0024): drive the real MCP request path
 * (tools/call over the SDK) against fake Helm Api data and assert the
 * structured JSON payloads, the report_progress acknowledgment + stderr
 * log, and the clean error mapping for unconfigured tokens / dead servers.
 */

const board: Board = {
  generatedAt: '2026-10-12T00:00:00.000Z',
  projects: [
    {
      id: 'prj_app',
      name: 'Companion App',
      repo: 'acme/companion-app',
      goal: 'ship v2',
      stage: 'build',
      priority: 'high',
      snapshot: { date: '2026-10-12', healthScore: 72, factors: {}, summary: 'CI red' },
      ci: {
        status: 'failing',
        branch: 'main',
        lastConclusion: 'failure',
        lastRunTs: null,
        failingSince: null,
        consecutiveFailures: 2,
      },
      milestones: { count: 1, averageProgress: 10, nearestDueDate: null },
      risks: [],
    },
    {
      id: 'prj_page',
      name: 'Product Page',
      repo: 'acme/product-page',
      goal: 'conversion',
      stage: 'operate',
      priority: 'medium',
      snapshot: null,
      ci: null,
      milestones: null,
      risks: [],
    },
  ],
};

const relation = {
  id: 'rel_1',
  sourceProjectId: 'prj_app',
  targetProjectId: 'prj_page',
  kind: 'app-to-product-page',
  rules: [],
  origin: 'manual',
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
};

const topGap: LinkageGap = {
  id: 'gap_top',
  relationId: 'rel_1',
  signal: 'privacy_policy',
  checkType: 'text_drift',
  description: 'page links the old policy',
  impact: 'stale terms',
  evidence: [
    { projectId: 'prj_app', path: 'src/legal/privacy.md', changedAt: '2026-10-10T00:00:00.000Z' },
  ],
  rootChangeId: 'rc_1',
  severity: 'high',
  status: 'open',
  detectedAt: '2026-10-10T00:00:00.000Z',
};

interface Harness {
  client: Client;
  logLines: string[];
  close(): Promise<void>;
}

/** tools/call returns a union (task results have no content) — narrow by hand. */
interface TextResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function firstText(result: unknown): string {
  const content = (result as TextResultLike).content?.[0];
  if (content === undefined || content.type !== 'text' || typeof content.text !== 'string') {
    throw new Error('expected a text content block');
  }
  return content.text;
}

function parseText(result: unknown): unknown {
  return JSON.parse(firstText(result));
}

function startServer(api: HelmApi): Promise<Harness> {
  const logLines: string[] = [];
  const server = createPhelmMcpServer({ client: api, log: (line) => logLines.push(line) });
  const client = new Client({ name: 'behavior-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const closer = async (): Promise<void> => {
    await client.close();
    await server.close();
  };
  openClosers.push(closer);
  return Promise.all([server.connect(serverTransport), client.connect(clientTransport)]).then(
    () => ({ client, logLines, close: closer }),
  );
}

const openClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(openClosers.map((closer) => closer()));
  openClosers.length = 0;
});

function fakeApi(overrides: Partial<HelmApi> = {}): HelmApi {
  const gapGroups: GapGroups = {
    groups: [
      {
        rootChangeId: 'rc_1',
        severity: 'high',
        firstDetectedAt: topGap.detectedAt,
        gaps: [topGap],
      },
    ],
    total: 1,
  };
  return {
    fetchBoard: vi.fn().mockResolvedValue(board),
    fetchRelations: vi.fn().mockResolvedValue([relation]),
    fetchOpenGapGroups: vi.fn().mockResolvedValue(gapGroups),
    fetchLatestBriefing: vi.fn().mockResolvedValue(null),
    reportProgress: vi.fn().mockResolvedValue({ received: true, audited: true }),
    ...overrides,
  };
}

describe('get_project_context behavior', () => {
  it('returns the structured context JSON', async () => {
    const { client } = await startServer(fakeApi());
    const result = await client.callTool({ name: 'get_project_context', arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = parseText(result) as { tracked: boolean; projects: Array<{ repo: string }> };
    expect(payload.tracked).toBe(true);
    expect(payload.projects.map((project) => project.repo)).toEqual([
      'acme/companion-app',
      'acme/product-page',
    ]);
  });

  it('answers an untracked repo with the explicit not-tracked message', async () => {
    const { client } = await startServer(fakeApi());
    const result = await client.callTool({
      name: 'get_project_context',
      arguments: { repo: 'acme/ghost' },
    });
    expect(result.isError).toBeFalsy();
    expect(parseText(result)).toEqual({
      tracked: false,
      repo: 'acme/ghost',
      message: 'project not tracked: no board project has repo "acme/ghost"',
    });
  });
});

describe('get_task behavior', () => {
  it('returns the flat advisory JSON for the top gap', async () => {
    const { client } = await startServer(fakeApi());
    const result = await client.callTool({ name: 'get_task', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(parseText(result)).toEqual({
      advisory: true,
      gapId: 'gap_top',
      signal: 'privacy_policy',
      severity: 'high',
      description: 'page links the old policy',
      impact: 'stale terms',
      repo: 'acme/companion-app',
      path: 'src/legal/privacy.md',
      actionUrl: 'https://github.com/acme/companion-app/blob/main/src/legal/privacy.md',
    });
  });

  it('returns the no-task advisory when every chain is in sync', async () => {
    const { client } = await startServer(
      fakeApi({ fetchOpenGapGroups: vi.fn().mockResolvedValue({ groups: [], total: 0 }) }),
    );
    const result = await client.callTool({ name: 'get_task', arguments: {} });
    expect(parseText(result)).toEqual({
      advisory: true,
      task: null,
      note: 'all chains are in sync',
    });
  });
});

describe('report_progress behavior', () => {
  it('delivers the report to the client and returns the persisted ack', async () => {
    const api = fakeApi();
    const { client, logLines } = await startServer(api);
    const result = await client.callTool({
      name: 'report_progress',
      arguments: { gapId: 'gap_top', status: 'done', note: 'fixed in #42' },
    });
    expect(result.isError).toBeFalsy();
    expect(parseText(result)).toEqual({ received: true, audited: true });
    expect(api.reportProgress).toHaveBeenCalledWith({
      gapId: 'gap_top',
      status: 'done',
      note: 'fixed in #42',
    });
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0] ?? '')).toEqual({
      event: 'report_progress',
      gapId: 'gap_top',
      status: 'done',
      noteLength: 12,
    });
  });

  it('marks the v1 receipt degraded when the server predates the report endpoint', async () => {
    const { client } = await startServer(
      fakeApi({
        reportProgress: vi
          .fn()
          .mockResolvedValue({ received: true, audited: false, degraded: true }),
      }),
    );
    const result = await client.callTool({
      name: 'report_progress',
      arguments: { status: 'in_progress' },
    });
    expect(result.isError).toBeFalsy();
    expect(parseText(result)).toEqual({ received: true, audited: false, degraded: true });
  });

  it('maps a client failure to the clean tool error', async () => {
    const { client } = await startServer(
      fakeApi({
        reportProgress: vi.fn().mockRejectedValue(new HelmNetworkError('http://localhost:3000')),
      }),
    );
    const result = await client.callTool({
      name: 'report_progress',
      arguments: { status: 'blocked', note: 'stuck on flaky CI' },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain(
      'cannot reach the Helm Agent server at http://localhost:3000',
    );
  });

  it('logs a null gapId when the report omits it', async () => {
    const { client, logLines } = await startServer(fakeApi());
    await client.callTool({ name: 'report_progress', arguments: { status: 'in_progress' } });
    expect(JSON.parse(logLines[0] ?? '')).toMatchObject({ gapId: null, status: 'in_progress' });
  });

  it('answers an invalid status with an input-validation tool error, without running the handler', async () => {
    const { client, logLines } = await startServer(fakeApi());
    const result = await client.callTool({
      name: 'report_progress',
      arguments: { status: 'shipped' },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Invalid arguments for tool report_progress');
    expect(firstText(result)).toContain('"in_progress"|"done"|"blocked"');
    expect(logLines).toHaveLength(0);
  });

  it('answers unknown fields with a validation error (strict input schema)', async () => {
    const { client, logLines } = await startServer(fakeApi());
    const result = await client.callTool({
      name: 'report_progress',
      arguments: { status: 'done', extra: 'nope' },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Unrecognized key: "extra"');
    expect(logLines).toHaveLength(0);
  });

  it('answers an empty gapId with a validation error (min length 1)', async () => {
    const { client } = await startServer(fakeApi());
    const result = await client.callTool({
      name: 'report_progress',
      arguments: { status: 'done', gapId: '' },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('>=1 characters at gapId');
  });
});

describe('tool error mapping', () => {
  it('maps a missing token to the clean "token not configured" tool error', async () => {
    const { client } = await startServer(
      fakeApi({ fetchBoard: vi.fn().mockRejectedValue(new TokenNotConfiguredError()) }),
    );
    const result = await client.callTool({ name: 'get_project_context', arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('token not configured');
  });

  it('maps a dead server to the cannot-reach tool error', async () => {
    const { client } = await startServer(
      fakeApi({
        fetchRelations: vi.fn().mockRejectedValue(new HelmNetworkError('http://localhost:3000')),
      }),
    );
    const result = await client.callTool({ name: 'get_task', arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain(
      'cannot reach the Helm Agent server at http://localhost:3000',
    );
  });
});
