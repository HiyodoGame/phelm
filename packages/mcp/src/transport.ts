#!/usr/bin/env node
import { IncomingMessage, ServerResponse, type RequestListener } from 'node:http';
import http from 'node:http';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { clientConfigFromEnv, HelmApiClient } from './client.js';
import { createPhelmMcpServer, type PhelmMcpDeps } from './server.js';

/**
 * Transport entry points (T-0024, ADR-006): `phelm-mcp` runs stdio by
 * default and `phelm-mcp --http <port>` serves Streamable HTTP. Every log
 * line goes to stderr — in stdio mode stdout IS the JSON-RPC protocol
 * stream, so nothing may ever write there except the SDK transport.
 *
 * HTTP mode is stateless (no session ids): each request gets a fresh
 * transport and server instance, so concurrent requests never share state
 * and a server restart needs no session cleanup. It binds the loopback
 * interface only — the v1 server is a local companion to the Helm Agent
 * API and carries no authentication of its own (the dedicated MCP token +
 * audit land in T-0025); do not expose it beyond localhost.
 */

export type TransportArgs = { mode: 'stdio' } | { mode: 'http'; port: number };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = `phelm-mcp - MCP server for Helm Agent

Usage:
  phelm-mcp               Talk MCP over stdio (default; agent config style)
  phelm-mcp --http <port> Serve MCP Streamable HTTP on 127.0.0.1:<port>/mcp

Environment:
  HELM_API_URL     Helm Agent API base URL (default http://localhost:3000)
  HELM_API_TOKEN   Helm Agent API token (required; tools answer with a clean
                   error when it is missing)`;

export function parseTransportArgs(argv: readonly string[]): TransportArgs {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--help' || arg === '-h') {
      throw new UsageError(USAGE);
    }
    if (arg === '--http' || arg.startsWith('--http=')) {
      const raw = arg === '--http' ? argv[index + 1] : arg.slice('--http='.length);
      if (raw === undefined || raw === '') {
        throw new UsageError('--http requires a port number\n\n' + USAGE);
      }
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new UsageError(`--http port must be an integer between 1 and 65535, got "${raw}"`);
      }
      return { mode: 'http', port };
    }
    throw new UsageError(`unknown argument "${arg}"\n\n` + USAGE);
  }
  return { mode: 'stdio' };
}

/** Default logger: stderr only, never stdout (the stdio protocol stream). */
const stderrLog = (line: string): void => {
  console.error(line);
};

/** stdio transport: connect once and keep the process alive until stdin closes. */
export async function runStdio(deps: PhelmMcpDeps): Promise<void> {
  const server = createPhelmMcpServer(deps);
  await server.connect(new StdioServerTransport());
  stderrLog('[phelm-mcp] stdio transport ready (server "phelm-mcp")');
}

/** Maximum accepted HTTP body size: MCP messages are small; refuse more. */
const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function httpErrorResponse(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
}

/**
 * One stateless request: a fresh server + transport pair answers it, so no
 * mutable state is shared across requests. (The per-request pair is the
 * SDK's documented stateless pattern.)
 */
async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PhelmMcpDeps,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on('close', () => {
    transport.close().catch(() => undefined);
  });
  const server = createPhelmMcpServer(deps);
  await server.connect(transport);
  if (request.method === 'POST') {
    const body = await readJsonBody(request);
    await transport.handleRequest(request, response, body);
  } else {
    await transport.handleRequest(request, response);
  }
}

/** The HTTP request listener: only POST/GET/DELETE on `/mcp` are MCP traffic. */
export function createHttpListener(deps: PhelmMcpDeps): RequestListener {
  return async (request, response) => {
    try {
      if (request.url !== '/mcp') {
        httpErrorResponse(response, 404, -32601, 'not found; the MCP endpoint is /mcp');
        return;
      }
      await handleHttpRequest(request, response, deps);
    } catch {
      // Body-level failures (too large, malformed JSON) answer as a JSON-RPC
      // parse error; anything else is an internal error. Protocol errors
      // inside the transport never reach here (it writes its own responses).
      httpErrorResponse(response, 400, -32700, 'parse error');
    }
  };
}

/**
 * HTTP transport: Streamable HTTP on 127.0.0.1:<port>/mcp (loopback only —
 * see the module comment for why). Resolves only when the server fails to
 * start; otherwise it keeps serving until the caller closes it.
 */
export async function runHttp(deps: PhelmMcpDeps, port: number): Promise<http.Server> {
  const httpServer = http.createServer(createHttpListener(deps));
  return new Promise<http.Server>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      stderrLog(`[phelm-mcp] http transport listening on http://127.0.0.1:${port}/mcp`);
      resolve(httpServer);
    });
  });
}

/** Wire the client from the environment; shared by both transports. */
export function depsFromEnv(
  env: { HELM_API_URL?: string; HELM_API_TOKEN?: string },
  log?: (line: string) => void,
): PhelmMcpDeps {
  return {
    client: new HelmApiClient(clientConfigFromEnv(env)),
    ...(log === undefined ? {} : { log }),
  };
}

/** Process entry: parse args, pick the transport, surface usage errors. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseTransportArgs(argv);
  const deps = depsFromEnv(process.env);
  if (args.mode === 'http') {
    await runHttp(deps, args.port);
  } else {
    await runStdio(deps);
  }
}

// npm installs bin targets through symlinks: resolve argv[1] through its real
// path before comparing with import.meta.url, or the check fails and the bin
// silently does nothing when invoked as `phelm-mcp` (same guard as the CLI).
const entryPoint = process.argv[1];
const isDirectRun =
  Boolean(entryPoint) && import.meta.url === pathToFileURL(realpathSync(entryPoint)).href;

if (isDirectRun) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`phelm-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
