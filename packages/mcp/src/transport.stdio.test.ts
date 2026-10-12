import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * stdio transport smoke test (T-0024 acceptance): spawns the BUILT bin
 * (`dist/transport.js`) and drives real newline-delimited JSON-RPC over
 * stdin/stdout. Beyond the protocol assertions it guards protocol-stream
 * purity — every stdout line must parse as JSON, so a stray console.log
 * added later turns this test red instead of corrupting agent sessions.
 *
 * CI runs `test` before `build`, so the test builds the dist itself when it
 * is missing (a no-op locally right after `pnpm build`).
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distEntry = join(packageRoot, 'dist', 'transport.js');
const TOKEN = 'stdio-smoke-token';

const board = {
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

const relations = {
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

const gapGroups = {
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

let apiPort = 0;
let apiServer: http.Server | undefined;
let child: ChildProcess | undefined;
let childError: Error | undefined;

interface JsonRpcResponse {
  id: number | string | null;
  result?: unknown;
  error?: unknown;
}

const pending = new Map<number, (message: JsonRpcResponse) => void>();
const stdoutLines: string[] = [];
let stderrText = '';

beforeAll(async () => {
  if (!existsSync(distEntry)) {
    // CI ordering: test runs before build — build once here, then smoke.
    execSync('npx tsc -p tsconfig.build.json', { cwd: packageRoot, stdio: 'ignore' });
  }
  apiServer = http.createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end('{}');
      return;
    }
    const url = request.url ?? '';
    const body =
      url === '/board'
        ? board
        : url === '/relations'
          ? relations
          : url.startsWith('/relations/rel_1/gaps')
            ? gapGroups
            : null; // /briefings/latest and anything else: 404 (no briefing yet)
    if (body === null) {
      response.writeHead(404).end('{}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => apiServer!.listen(0, '127.0.0.1', resolve));
  apiPort = (apiServer!.address() as { port: number }).port;
  void apiServer!.unref();

  child = spawn(process.execPath, [distEntry], {
    env: {
      ...process.env,
      HELM_API_URL: `http://127.0.0.1:${apiPort}`,
      HELM_API_TOKEN: TOKEN,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('error', (error) => {
    childError = error;
  });
  let buffer = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') {
        stdoutLines.push(line);
        const message = JSON.parse(line) as JsonRpcResponse;
        pending.get(message.id as number)?.(message);
      }
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderrText += chunk;
  });
}, 120_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => {
    if (child === undefined || child.exitCode !== null || !child.killed) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    setTimeout(resolve, 2000).unref();
  });
  apiServer?.close();
  pending.clear();
});

function writeToStdin(line: string): void {
  const stdin = child?.stdin;
  if (stdin === undefined || stdin === null) {
    throw new Error('stdio smoke: child stdin is gone');
  }
  stdin.write(line);
}

function request(method: string, params?: unknown, id?: number): Promise<JsonRpcResponse> {
  const requestId = id ?? Math.floor(Math.random() * 1_000_000) + 10;
  return new Promise((resolve, reject) => {
    pending.set(requestId, resolve);
    writeToStdin(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000).unref();
  });
}

describe('stdio transport smoke (built bin)', () => {
  it('answers initialize, tools/list and tools/call over the stdio protocol stream', async () => {
    expect(childError).toBeUndefined();

    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-smoke', version: '0.0.0' },
    });
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'phelm-mcp', version: '0.0.1' },
    });
    writeToStdin(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const list = await request('tools/list');
    const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names.sort()).toEqual(['get_project_context', 'get_task', 'report_progress']);

    const advisory = await request('tools/call', { name: 'get_task', arguments: {} });
    const text = (advisory.result as { content: Array<{ type: string; text: string }> }).content[0]!
      .text;
    expect(JSON.parse(text)).toMatchObject({
      advisory: true,
      gapId: 'gap_1',
      severity: 'high',
      actionUrl: 'https://github.com/acme/companion-app/blob/main/src/legal/privacy.md',
    });

    const ack = await request('tools/call', {
      name: 'report_progress',
      arguments: { gapId: 'gap_1', status: 'in_progress', note: 'picking it up' },
    });
    const ackText = (ack.result as { content: Array<{ type: string; text: string }> }).content[0]!
      .text;
    expect(JSON.parse(ackText)).toEqual({
      received: true,
      audit: 'server-side audit log lands in T-0025; nothing is persisted yet',
    });
  }, 30_000);

  it('keeps stdout protocol-pure: every line is JSON-RPC, no stray logs', () => {
    // The guardrail: anything that ever writes to stdout (console.log, a
    // debug print) breaks the stdio protocol — make that a red test here.
    expect(stdoutLines.length).toBeGreaterThanOrEqual(4);
    for (const line of stdoutLines) {
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toMatchObject({ jsonrpc: '2.0' });
    }
  });

  it('logs the ready line (and only work logs) on stderr', () => {
    expect(stderrText).toContain('stdio transport ready');
    expect(stderrText).toContain('report_progress');
  });
});
