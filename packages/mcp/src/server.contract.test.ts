import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { HelmApi } from './client.js';
import { createPhelmMcpServer } from './server.js';

/**
 * Tool schema CONTRACT tests (T-0024): the three tools' public inputSchema,
 * names and boundary wording are pinned here so a schema drift is a test
 * failure, not a silent agent-facing change. Assertions are explicit
 * (field names / types / required / enum), not snapshot hashes, so a
 * breaking change says exactly what moved.
 */

const noopApi: HelmApi = {
  fetchBoard: vi.fn().mockResolvedValue({ generatedAt: '', projects: [] }),
  fetchRelations: vi.fn().mockResolvedValue([]),
  fetchOpenGapGroups: vi.fn().mockResolvedValue({ groups: [], total: 0 }),
  fetchLatestBriefing: vi.fn().mockResolvedValue(null),
  reportProgress: vi.fn().mockResolvedValue({ received: true, audited: true }),
};

async function listToolSchemas(deps = { client: noopApi }) {
  const server = createPhelmMcpServer(deps);
  const client = new Client({ name: 'contract-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  } finally {
    await client.close();
    await server.close();
  }
}

describe('tool schema contract', () => {
  it('contract: registers exactly the three consultative tools', async () => {
    const tools = await listToolSchemas();
    expect(Object.keys(tools).sort()).toEqual([
      'get_project_context',
      'get_task',
      'report_progress',
    ]);
  });

  it('contract: get_project_context input is { repo?: string } and rejects unknown fields', async () => {
    const tools = await listToolSchemas();
    const schema = tools.get_project_context?.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toEqual({
      repo: { type: 'string', minLength: 1 },
    });
    expect(schema.required === undefined || (schema.required as string[]).length === 0).toBe(true);
  });

  it('contract: get_task input is the empty strict object', async () => {
    const tools = await listToolSchemas();
    const schema = tools.get_task?.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.properties).toEqual({});
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required === undefined || (schema.required as string[]).length === 0).toBe(true);
  });

  it('contract: report_progress input pins gapId?/status/note? with the status enum', async () => {
    const tools = await listToolSchemas();
    const schema = tools.report_progress?.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toEqual({
      gapId: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['in_progress', 'done', 'blocked'] },
      note: { type: 'string', minLength: 1 },
    });
    expect(schema.required).toEqual(['status']);
  });

  it('contract: get_task description states the advisory-only, no-claim v1 boundary', async () => {
    const tools = await listToolSchemas();
    const description = tools.get_task?.description ?? '';
    expect(description).toContain('ADVISORY ONLY');
    expect(description.toLowerCase()).toContain('v1 boundary');
    expect(description.toLowerCase()).toContain('does not');
  });

  it('contract: report_progress description states the persisted, audited semantics', async () => {
    const tools = await listToolSchemas();
    const description = tools.report_progress?.description ?? '';
    expect(description.toUpperCase()).toContain('PERSISTED SERVER-SIDE');
    expect(description).toContain('audit log');
    // The degraded fallback stays documented: an old server answers degraded:true.
    expect(description).toContain('"degraded": true');
    // The T-0024 "nothing is persisted" wording must not come back silently.
    expect(description.toUpperCase()).not.toContain('NOTHING IS PERSISTED');
  });

  it('contract: get_project_context description states read-only semantics', async () => {
    const tools = await listToolSchemas();
    const description = tools.get_project_context?.description ?? '';
    expect(description).toContain('Read-only');
    expect(description).toContain('project not tracked');
  });
});
