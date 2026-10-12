import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HelmNetworkError, type HelmApi } from './client.js';
import { createHttpListener } from './transport.js';

/**
 * Real-wire HTTP tests (T-0024): JSON-RPC 2.0 over Streamable HTTP with a
 * plain HTTP client (no SDK client), so the wire format itself is asserted —
 * initialize handshake, tools/list, tools/call, the error paths (unknown
 * path, malformed JSON body, internal failure) and the DNS-rebinding
 * defenses (forged Host, browser Origin).
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

interface RawResponse {
  status: number;
  payload: unknown;
}

/**
 * Raw node:http request — fetch forbids setting Host/Origin, and those are
 * exactly the headers the DNS-rebinding tests need to forge. SSE responses
 * are long-lived streams: resolve on the first `data:` frame and tear the
 * connection down; JSON bodies resolve on `end` as usual.
 */
function rawRequest(
  port: number,
  headers: Record<string, string>,
  body: unknown,
  path = '/mcp',
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers },
      (response) => {
        const status = response.statusCode ?? 0;
        const eventStream = (response.headers['content-type'] ?? '').includes('text/event-stream');
        const chunks: Buffer[] = [];
        const parseText = (text: string): unknown => {
          if (!eventStream) {
            return JSON.parse(text || 'null');
          }
          const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
          return JSON.parse(dataLine === undefined ? 'null' : dataLine.slice(5).trim());
        };
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          if (eventStream) {
            const text = Buffer.concat(chunks).toString('utf8');
            if (text.includes('data:')) {
              resolve({ status, payload: parseText(text) });
              request.destroy();
            }
          }
        });
        response.on('end', () => {
          resolve({ status, payload: parseText(Buffer.concat(chunks).toString('utf8')) });
        });
      },
    );
    request.on('error', reject);
    request.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

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

interface Listener {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Start one listener on an ephemeral port; always close it via the handle. */
async function startListener(api: HelmApi = noopApi): Promise<Listener> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // Same attach-after-bind shape as runHttp: the DNS-rebinding allowlist
  // needs the bound port.
  server.on('request', createHttpListener({ client: api }, port));
  void server.unref();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

describe('HTTP transport (wire format)', () => {
  it('answers initialize with the phelm-mcp server info and tool capability', async () => {
    const listener = await startListener();
    try {
      const { status, payload } = await post(listener.url, INITIALIZED);
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
    } finally {
      await listener.close();
    }
  });

  it('answers tools/list with exactly the three consultative tools', async () => {
    const listener = await startListener();
    try {
      await post(listener.url, INITIALIZED);
      const { status, payload } = await post(listener.url, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });
      expect(status).toBe(200);
      const tools = (payload as { result: { tools: Array<{ name: string }> } }).result.tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'get_project_context',
        'get_task',
        'report_progress',
      ]);
    } finally {
      await listener.close();
    }
  });

  it('answers tools/call report_progress with the structured ack JSON', async () => {
    const listener = await startListener();
    try {
      await post(listener.url, INITIALIZED);
      const { status, payload } = await post(listener.url, {
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
    } finally {
      await listener.close();
    }
  });

  it('maps tool client failures to isError results (clean, not a crash)', async () => {
    const failingApi: HelmApi = {
      ...noopApi,
      fetchBoard: vi.fn().mockRejectedValue(new HelmNetworkError('http://localhost:3000')),
    };
    const listener = await startListener(failingApi);
    try {
      await post(listener.url, INITIALIZED);
      const { payload } = await post(listener.url, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_project_context', arguments: {} },
      });
      const result = (payload as { result: { isError: boolean; content: Array<{ text: string }> } })
        .result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('cannot reach the Helm Agent server');
    } finally {
      await listener.close();
    }
  });

  it('answers a non-/mcp path with a JSON-RPC 404 and malformed JSON with a parse error', async () => {
    const listener = await startListener();
    try {
      const base = listener.url.replace(/\/mcp$/, '');

      const notFound = await post(`${base}/other`, INITIALIZED);
      expect(notFound.status).toBe(404);
      expect(notFound.payload).toMatchObject({
        error: { code: -32601, message: expect.stringContaining('/mcp') },
      });

      const malformed = await post(listener.url, '{"jsonrpc":"2.0" nope');
      expect(malformed.status).toBe(400);
      expect(malformed.payload).toMatchObject({ error: { code: -32700 } });
    } finally {
      await listener.close();
    }
  });

  it('rejects a forged Host header with 403 (DNS rebinding defense)', async () => {
    const listener = await startListener();
    try {
      const forged = await rawRequest(
        listener.port,
        {
          Host: 'attacker.example:1',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        INITIALIZED,
      );
      expect(forged.status).toBe(403);
      expect(forged.payload).toMatchObject({
        error: { code: -32000, message: expect.stringContaining('Invalid Host header') },
      });
    } finally {
      await listener.close();
    }
  });

  it('rejects browser-originated requests (Origin header) even with a valid Host', async () => {
    const listener = await startListener();
    try {
      const withOrigin = await rawRequest(
        listener.port,
        {
          Host: `127.0.0.1:${listener.port}`,
          Origin: 'http://attacker.example',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        INITIALIZED,
      );
      expect(withOrigin.status).toBe(403);
      expect(withOrigin.payload).toMatchObject({
        error: { code: -32000, message: expect.stringContaining('browser-originated') },
      });
    } finally {
      await listener.close();
    }
  });

  it('serves non-browser requests (valid Host, no Origin) normally', async () => {
    const listener = await startListener();
    try {
      // raw node:http with only the mandatory headers — no Origin, Host is
      // the listener's own — must pass the rebinding defenses.
      const ok = await rawRequest(
        listener.port,
        {
          Host: `127.0.0.1:${listener.port}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        INITIALIZED,
      );
      expect(ok.status).toBe(200);
      expect(ok.payload).toMatchObject({
        result: { serverInfo: { name: 'phelm-mcp' } },
      });
    } finally {
      await listener.close();
    }
  });
});
