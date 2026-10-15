import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HelmClientError, type HelmApi } from './client.js';
import { buildProjectContext } from './context.js';
import { MCP_SERVER_INFO } from './info.js';
import { buildAdvisory } from './task.js';

/**
 * The phelm MCP server (T-0024): three consultative tools over the Helm
 * Agent data plane — `get_project_context` (snapshot + linkage context),
 * `get_task` (advisory next work item) and `report_progress` (validated
 * report persisted server-side to the audit log, T-0025; a server predating
 * the intake endpoint falls back to the v1 local receipt with
 * `degraded: true`). Read-only + report: no tool mutates server state — the
 * boundary is stated in the tool descriptions so agents reading the tool
 * list know it before calling.
 */

export interface PhelmMcpDeps {
  /** Helm Agent REST client (token/config come from env via the caller). */
  client: HelmApi;
  /**
   * One-line structured logger. Defaults to console.error — stderr only,
   * never stdout: in stdio mode stdout IS the protocol stream.
   */
  log?: (line: string) => void;
}

/** Map a client failure to the clean single-line message a tool returns. */
export function toolErrorMessage(error: unknown): string {
  if (error instanceof HelmClientError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function textResult(payload: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function createPhelmMcpServer(deps: PhelmMcpDeps): McpServer {
  const log = deps.log ?? ((line: string) => console.error(line));
  const server = new McpServer(MCP_SERVER_INFO);

  server.registerTool(
    'get_project_context',
    {
      description:
        'Read a project context snapshot from the Helm Agent server. For every tracked project ' +
        '(or only the one matching `repo`, e.g. "owner/name") it returns the board health data ' +
        '(health score, factors, summary, CI status, milestones, open risks), the ACTIVE linkage ' +
        'relations involving the project (with counterparty name/repo) and each relation\u2019s open ' +
        'gaps (id/severity/description), plus the latest daily briefing when one exists. Read-only: ' +
        'this tool never writes to the server. A repo that is not tracked answers with an explicit ' +
        '"project not tracked" message instead of an empty result.',
      inputSchema: z.strictObject({
        repo: z.string().min(1).max(200).optional(),
      }),
    },
    async (args) => {
      try {
        const context = await buildProjectContext(deps.client, { repo: args.repo });
        return textResult(context);
      } catch (error) {
        return { content: [{ type: 'text', text: toolErrorMessage(error) }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_task',
    {
      description:
        'Consult the Helm Agent server for the single most urgent open linkage gap across all ' +
        'active relations, ordered by severity (high > medium > low) then detection recency. ' +
        'ADVISORY ONLY: this tool writes nothing to the server and does NOT claim, assign or ' +
        'reserve the task — there is no claim semantics yet; the result is a suggestion to ' +
        'evaluate (task dispatch semantics land when the judgment layer is restored; that is ' +
        'the v1 boundary). Returns a flat advisory description (gapId, signal, severity, ' +
        'description, impact, repo, path, actionUrl) or, when every chain is in sync, ' +
        '{ task: null, note: "all chains are in sync" }.',
      inputSchema: z.strictObject({}),
    },
    async () => {
      try {
        const advisory = await buildAdvisory(deps.client);
        return textResult(advisory);
      } catch (error) {
        return { content: [{ type: 'text', text: toolErrorMessage(error) }], isError: true };
      }
    },
  );

  server.registerTool(
    'report_progress',
    {
      description:
        'Report progress on a linkage gap back to Helm, e.g. after an agent picked up a get_task ' +
        'advisory. Inputs: status (required, one of "in_progress" | "done" | "blocked"), gapId ' +
        '(optional, the gap the progress refers to) and note (optional, free text). The report ' +
        'is validated and PERSISTED SERVER-SIDE: an accepted report lands in the Helm Agent ' +
        'audit log (which connection token reported what, when) before the acknowledgment is ' +
        'returned. When the connected server predates this endpoint the tool answers with ' +
        '"degraded": true — a receipt only, nothing is stored.',
      // Caps mirror the api's POST /mcp/reports body one-to-one: the payload
      // lands in the server-side audit jsonb, so an unbounded note would be
      // a storage-exhaustion amplifier. Keep both sides in lockstep.
      inputSchema: z.strictObject({
        gapId: z.string().min(1).max(64).optional(),
        status: z.enum(['in_progress', 'done', 'blocked']),
        note: z.string().min(1).max(2000).optional(),
      }),
    },
    async (args) => {
      // Structured stderr log of the attempt (local record only — the
      // server-side record is the audit log the client reports into).
      log(
        JSON.stringify({
          event: 'report_progress',
          gapId: args.gapId ?? null,
          status: args.status,
          noteLength: args.note?.length ?? 0,
        }),
      );
      try {
        const result = await deps.client.reportProgress(args);
        return textResult(result);
      } catch (error) {
        return { content: [{ type: 'text', text: toolErrorMessage(error) }], isError: true };
      }
    },
  );

  return server;
}
