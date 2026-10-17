import {
  LinkageEvidenceSchema,
  ProjectRelationSchema,
  SignalKindSchema,
  TimestampSchema,
  type ProjectRelation,
} from '@phelm/contract';
import { z } from 'zod';

/**
 * REST client for the Helm Agent data plane (T-0024): the MCP tools are a
 * thin layer over four read endpoints — `GET /board`, `GET /relations`,
 * `GET /relations/:id/gaps?status=open` and `GET /briefings/latest` — each
 * guarded by the shared bearer token, plus the `POST /mcp/reports` intake
 * (T-0025) that persists a validated progress report to the server-side
 * audit log. The shapes below mirror what the api publishes (board is
 * re-validated like the CLI does; gaps/briefings are api-internal shapes
 * pinned client-side so drift is loud), and every failure maps to a typed
 * error instead of a raw fetch exception.
 *
 * Auth lives entirely in env (`HELM_API_URL` / `HELM_API_TOKEN`): a missing
 * token never crashes the server — tool calls answer with the clean
 * "token not configured" error (see TokenNotConfiguredError). The token is
 * an MCP connection token (`mcp_`-prefixed, issued by the operator via
 * `POST /mcp/tokens`); the operator token also works but is not what agents
 * should hold.
 */

export type HelmClientErrorCode =
  | 'token_not_configured'
  | 'network'
  | 'unauthorized'
  | 'service_unavailable'
  | 'not_found'
  | 'unexpected_response';

/** Base class so tool handlers can catch every client failure in one arm. */
export class HelmClientError extends Error {
  readonly code: HelmClientErrorCode;

  constructor(code: HelmClientErrorCode, message: string) {
    super(message);
    this.name = 'HelmClientError';
    this.code = code;
  }
}

export class TokenNotConfiguredError extends HelmClientError {
  constructor(message = 'token not configured: set HELM_API_TOKEN (the Helm Agent API token)') {
    super('token_not_configured', message);
    this.name = 'TokenNotConfiguredError';
  }
}

export class HelmNetworkError extends HelmClientError {
  constructor(apiBaseUrl: string) {
    super('network', `cannot reach the Helm Agent server at ${apiBaseUrl} (is it running?)`);
    this.name = 'HelmNetworkError';
  }
}

export class HelmUnauthorizedError extends HelmClientError {
  constructor() {
    super('unauthorized', 'the Helm Agent server rejected the API token (check HELM_API_TOKEN)');
    this.name = 'HelmUnauthorizedError';
  }
}

export class HelmServiceUnavailableError extends HelmClientError {
  constructor() {
    super(
      'service_unavailable',
      'the Helm Agent server has its API disabled (API_AUTH_TOKEN unconfigured server-side)',
    );
    this.name = 'HelmServiceUnavailableError';
  }
}

export class HelmNotFoundError extends HelmClientError {
  constructor(resource: string) {
    super('not_found', `${resource} not found on the Helm Agent server`);
    this.name = 'HelmNotFoundError';
  }
}

export class HelmUnexpectedResponseError extends HelmClientError {
  constructor(status: number | undefined, detail: string) {
    super(
      'unexpected_response',
      status === undefined
        ? `unexpected Helm Agent response: ${detail}`
        : `unexpected Helm Agent response (status ${status}): ${detail}`,
    );
    this.name = 'HelmUnexpectedResponseError';
  }
}

export interface HelmApiConfig {
  apiBaseUrl: string;
  /**
   * Empty string = not configured. Kept on the instance (instead of rejected
   * in the constructor) so the MCP server starts without a token and tool
   * calls answer with the clean token-not-configured error.
   */
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 30 000); timeouts map to network errors. */
  timeoutMs?: number;
  /**
   * One-line structured logger for client-side events that must not be
   * silent (notably the degraded report fallback). Defaults to
   * console.error — stderr, so stdio mode's protocol stream stays pure.
   */
  log?: (line: string) => void;
}

/** Default per-request timeout: a hung data plane must not hang the agent. */
const DEFAULT_TIMEOUT_MS = 30_000;

export function clientConfigFromEnv(env: {
  HELM_API_URL?: string;
  HELM_API_TOKEN?: string;
}): HelmApiConfig {
  // A whitespace-only URL counts as unset (same discipline as the token).
  const configuredUrl = (env.HELM_API_URL ?? '').trim();
  return {
    apiBaseUrl: (configuredUrl === '' ? 'http://localhost:3000' : configuredUrl).replace(
      /\/+$/,
      '',
    ),
    token: env.HELM_API_TOKEN ?? '',
  };
}

/** Client surface the tools depend on — narrow for test fakes. */
export interface HelmApi {
  fetchBoard(): Promise<Board>;
  fetchRelations(): Promise<ProjectRelation[]>;
  fetchOpenGapGroups(relationId: string): Promise<GapGroups>;
  fetchLatestBriefing(): Promise<Briefing | null>;
  reportProgress(input: ReportProgressInput): Promise<ReportProgressResult>;
}

/**
 * `report_progress` input — mirrors the api's POST /mcp/reports body (and
 * the MCP tool's input schema) one-to-one, so anything the tool accepted the
 * api accepts too.
 */
export interface ReportProgressInput {
  gapId?: string;
  status: 'in_progress' | 'done' | 'blocked';
  note?: string;
}

/**
 * Server ack: the report passed validation and was persisted to the
 * server-side audit log (T-0025) before the response was written.
 */
export interface ReportProgressAck {
  received: true;
  audited: true;
}

/**
 * Fallback for a server that predates POST /mcp/reports (it answers 404):
 * the v1 semantics — validate locally, acknowledge, persist NOTHING — with
 * an explicit degraded flag so the agent knows this is a receipt, not a
 * record.
 */
export interface ReportProgressDegraded {
  received: true;
  audited: false;
  degraded: true;
}

export type ReportProgressResult = ReportProgressAck | ReportProgressDegraded;

/** The api's success body for POST /mcp/reports, pinned client-side. */
const reportAckSchema = z
  .object({
    received: z.literal(true),
    audited: z.literal(true),
  })
  .strict();

/** loopback hosts where cleartext http is acceptable (traffic never leaves the machine). */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

export class HelmApiClient implements HelmApi {
  private readonly fetchFn: typeof fetch;
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(config: HelmApiConfig) {
    this.fetchFn = config.fetch ?? fetch;
    this.base = config.apiBaseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = config.log ?? ((line: string) => console.error(line));
    // Cleartext http to a non-loopback host would put the bearer token on the
    // wire unencrypted (review P2 hardening): the deployment is almost
    // certainly misconfigured, so say so once on stderr and continue — the
    // operator decides, the client does not silently encrypt-or-refuse.
    const url = new URL(this.base);
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      this.log(
        `warning: HELM_API_URL uses cleartext http (${this.base}); the API token travels unencrypted — use https or a loopback address`,
      );
    }
  }

  fetchBoard(): Promise<Board> {
    return this.request('/board', boardSchema);
  }

  fetchRelations(): Promise<ProjectRelation[]> {
    return this.request('/relations', relationsResponseSchema).then((parsed) => parsed.relations);
  }

  fetchOpenGapGroups(relationId: string): Promise<GapGroups> {
    return this.request(
      `/relations/${encodeURIComponent(relationId)}/gaps?status=open`,
      gapGroupsSchema,
    );
  }

  /**
   * The most recent daily briefing, or null when none has been generated yet
   * (404 is the api's "no briefing" answer, not an error for this read).
   */
  fetchLatestBriefing(): Promise<Briefing | null> {
    return this.request('/briefings/latest', briefingSchema, { notFoundIsNull: true });
  }

  /**
   * POST /mcp/reports (T-0025): deliver a progress report for persistence.
   * A 404 means the connected server predates the endpoint — degrade to the
   * v1 local-ack semantics instead of erroring, with degraded: true on the
   * result so the caller never mistakes it for a persisted record.
   */
  async reportProgress(input: ReportProgressInput): Promise<ReportProgressResult> {
    if (this.token === '') {
      throw new TokenNotConfiguredError();
    }
    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}/mcp/reports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.timeoutMs),
        // Same-origin redirects must not replay the token (see request()).
        redirect: 'error',
      });
    } catch {
      throw new HelmNetworkError(this.base);
    }
    if (response.status === 404) {
      // Old server without the endpoint: the v1 receipt, marked degraded.
      // Logged loudly (with the URL actually used) so a misconfigured base
      // URL cannot hide behind silent degradation during debugging.
      this.log(
        JSON.stringify({
          event: 'report_progress_degraded',
          url: `${this.base}/mcp/reports`,
          reason: 'server answered 404 (predates POST /mcp/reports); answering the v1 receipt',
        }),
      );
      return { received: true, audited: false, degraded: true };
    }
    if (response.status === 401) {
      throw new HelmUnauthorizedError();
    }
    if (response.status === 503) {
      throw new HelmServiceUnavailableError();
    }
    if (!response.ok) {
      throw new HelmUnexpectedResponseError(response.status, 'report POST to /mcp/reports failed');
    }
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = reportAckSchema.safeParse(body);
    if (!parsed.success) {
      throw new HelmUnexpectedResponseError(response.status, 'malformed payload for /mcp/reports');
    }
    return parsed.data;
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { notFoundIsNull?: boolean } = {},
  ): Promise<T> {
    if (this.token === '') {
      throw new TokenNotConfiguredError();
    }
    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}${path}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
        // Never follow redirects (review P2 hardening): same-origin redirects
        // would re-send the Authorization header to wherever the (ops
        // -controlled) base URL points; a misconfigured base should fail
        // loudly instead of quietly replaying the token elsewhere.
        redirect: 'error',
      });
    } catch {
      throw new HelmNetworkError(this.base);
    }
    if (response.status === 401) {
      throw new HelmUnauthorizedError();
    }
    if (response.status === 503) {
      throw new HelmServiceUnavailableError();
    }
    if (response.status === 404) {
      if (options.notFoundIsNull) {
        return null as T;
      }
      throw new HelmNotFoundError(path);
    }
    if (!response.ok) {
      throw new HelmUnexpectedResponseError(response.status, `request to ${path} failed`);
    }
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new HelmUnexpectedResponseError(response.status, `malformed payload for ${path}`);
    }
    return parsed.data;
  }
}

/** ---------- response shapes (client-side pins of the api surface) ---------- */

const boardSnapshotSchema = z.object({
  date: z.string(),
  healthScore: z.number(),
  // T-0017: mirrors the contract's nullable factor values — a factor with no
  // real signal is `null`, and rejecting it here would invalidate the entire
  // board response for every project.
  factors: z.record(z.string(), z.number().nullable()),
  summary: z.string(),
});

const boardCiSchema = z.object({
  status: z.string(),
  branch: z.string(),
  lastConclusion: z.string().nullable(),
  lastRunTs: z.string().nullable(),
  failingSince: z.string().nullable(),
  consecutiveFailures: z.number(),
});

const boardMilestonesSchema = z.object({
  count: z.number(),
  averageProgress: z.number(),
  nearestDueDate: z.string().nullable(),
});

/** Same shape the CLI re-validates (`packages/cli/src/board.ts`); non-strict so the api can add fields. */
export const boardSchema = z.object({
  generatedAt: z.string(),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      repo: z.string(),
      goal: z.string(),
      stage: z.string(),
      priority: z.string(),
      snapshot: boardSnapshotSchema.nullable(),
      ci: boardCiSchema.nullable(),
      milestones: boardMilestonesSchema.nullable(),
      risks: z.array(z.object({ type: z.string(), level: z.string(), impact: z.string() })),
    }),
  ),
});

export type Board = z.infer<typeof boardSchema>;
export type BoardProject = Board['projects'][number];

/** The relation list rides the versioned contract entities (ADR-005). */
const relationsResponseSchema = z.object({
  relations: z.array(ProjectRelationSchema),
});

/**
 * One gap row as the api returns it (camelCase; contract-validated cores,
 * api-internal checkType/resolvedAt — mirrors services/api routes/relations
 * gaps projection).
 */
export const linkageGapSchema = z.object({
  id: z.string().min(1),
  relationId: z.string().min(1),
  signal: SignalKindSchema,
  checkType: z.string().min(1),
  description: z.string().min(1),
  impact: z.string().min(1),
  evidence: z.array(LinkageEvidenceSchema).min(1),
  rootChangeId: z.string().min(1),
  severity: z.enum(['high', 'medium', 'low']),
  status: z.enum(['open', 'resolved', 'dismissed']),
  detectedAt: TimestampSchema,
  /** Absent while the gap is open (omitted, never null). */
  resolvedAt: TimestampSchema.optional(),
});

export type LinkageGap = z.infer<typeof linkageGapSchema>;

const gapGroupSchema = z.object({
  rootChangeId: z.string().min(1),
  severity: z.enum(['high', 'medium', 'low']),
  firstDetectedAt: TimestampSchema,
  gaps: z.array(linkageGapSchema).min(1),
});

export const gapGroupsSchema = z.object({
  groups: z.array(gapGroupSchema),
  total: z.number().int().nonnegative(),
});

export interface GapGroup {
  rootChangeId: string;
  severity: 'high' | 'medium' | 'low';
  firstDetectedAt: string;
  gaps: LinkageGap[];
}

export interface GapGroups {
  groups: GapGroup[];
  total: number;
}

/** Latest-briefing shape (api-internal, zod-pinned here the same way). */
export const briefingSchema = z.object({
  date: z.string(),
  stats: z.object({
    totalGaps: z.number().int().nonnegative(),
    relations: z.number().int().nonnegative(),
    maxSeverity: z.enum(['high', 'medium', 'low', 'none']),
    chains: z.number().int().nonnegative(),
    pendingDrafts: z.number().int().nonnegative(),
    draftRelations: z.number().int().nonnegative(),
  }),
  contentMd: z.string().min(1),
});

export type Briefing = z.infer<typeof briefingSchema>;
