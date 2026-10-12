import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HelmNetworkError, type HelmApi } from './client.js';
import { createHttpListener } from './transport.js';
import { vi } from 'vitest';

/**
 * Real-wire HTTP tests (T-0024): JSON-RPC 2.0 over Streamable HTTP with a
 * plain HTTP client (no SDK client), so the wire format itself is asserted —
 * initialize handshake, tools/list, tools/call, plus the error paths
 * (unknown path, malformed JSON body).
 */

const noopApi: HelmApi = {
  fetchBoard: vi.fn().mockResolvedValue({ generatedAt: '', projects: [] }),
  fetchRelations: vi.fn().mockResolvedValue([]),
  fetchOpenGapGroups: vi.fn().mockResolvedValue({ groups: [], total: 0 }),
  fetchLatestBriefing: vi.fn().mockResolvedValue(null),
};

const INITIALIZED = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'wire-test', version: '0.0.0' },
  },
};

async function post(
  url: string,
  body: unknown,
): Promise<{ status: number; contentType: string; payload: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  // The transport may answer either a plain JSON body or an SSE stream with
  // the JSON-RPC message on the `data:` line — both are spec-legal.
  const payloadText = contentType.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('') || 'null'
    : text;
  return {
    status: response.status,
    contentType,
    payload: payloadText === '' ? null : JSON.parse(payloadText),
  };
}

async function startListener(): Promise<string> {
  const server = http.createServer(createHttpListener({ client: noopApi }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;
  void server.unref();
  return url;
}

describe('HTTP transport (wire format)', () => {
  it('answers initialize with the phelm-mcp server info and tool capability', async () => {
    const url = await startListener();
    const { status, payload } = await post(url, INITIALIZED);
    expect(status).toBe(200);
    expect(payload).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'phelm-mcp', version: '0.0.1' },
        capabilities: { tools: {} },
      },
    });
  });

  it('answers tools/list with exactly the three consultative tools', async () => {
    const url = await startListener();
    await post(url, INITIALIZED);
    const { status, payload } = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(status).toBe(200);
    expect(payload).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'get_project_context' }),
          expect.objectContaining({ name: 'get_task' }),
          expect.objectContaining({ name: 'report_progress' }),
        ]),
      },
    });
    const tools = (payload as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_project_context',
      'get_task',
      'report_progress',
    ]);
  });

  it('answers tools/call report_progress with the structured ack JSON', async () => {
    const url = await startListener();
    await post(url, INITIALIZED);
    const { status, payload } = await post(url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'report_progress', arguments: { status: 'done' } },
    });
    expect(status).toBe(200);
    const result = (payload as { result: { content: Array<{ type: string; text: string }> } })
      .result;
    const ack = JSON.parse(result.content[0]!.text) as unknown;
    expect(ack).toEqual({
      received: true,
      audit: 'server-side audit log lands in T-0025; nothing is persisted yet',
    });
  });

  it('maps tool client failures to isError results (clean, not a crash)', async () => {
    const failingApi: HelmApi = {
      ...noopApi,
      fetchBoard: vi.fn().mockRejectedValue(new HelmNetworkError('http://localhost:3000')),
    };
    const server = http.createServer(createHttpListener({ client: failingApi }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/mcp`;
    await post(url, INITIALIZED);
    const { payload } = await post(url, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_project_context', arguments: {} },
    });
    const result = (payload as { result: { isError: boolean; content: Array<{ text: string }> } })
      .result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('cannot reach the Helm Agent server');
  });

  it('answers a non-/mcp path with a JSON-RPC 404 and malformed JSON with a parse error', async () => {
    const url = await startListener();
    const base = url.replace(/\/mcp$/, '');

    const notFound = await post(`${base}/other`, INITIALIZED);
    expect(notFound.status).toBe(404);
    expect(notFound.payload).toMatchObject({
      error: { code: -32601, message: expect.stringContaining('/mcp') },
    });

    const malformed = await post(url, '{"jsonrpc":"2.0" nope');
    expect(malformed.status).toBe(400);
    expect(malformed.payload).toMatchObject({ error: { code: -32700 } });
  });
});
