import { warnCleartextApiUrl } from './board.js';
import { z } from 'zod';

/**
 * Briefing fetching + terminal output for `phelm brief` / `phelm today`
 * (T-0022), consuming the Helm Agent briefing endpoints (T-0020).
 *
 * The CLI validates the server response against the same shape the api
 * publishes, then prints the briefing markdown VERBATIM: stdout receives
 * `contentMd` byte-for-byte (no prefix, no trailing rewrite, no ANSI), so
 * what this shows is exactly what the push channels deliver. The only extra
 * line is the meta note on stderr.
 */

export class BriefingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BriefingError';
  }
}

/** Thrown when a dated briefing does not exist (404) — expected, not broken. */
export class BriefingNotFoundError extends BriefingError {
  constructor(readonly date: string) {
    super(`no briefing for ${date}`);
    this.name = 'BriefingNotFoundError';
  }
}

const briefingStatsSchema = z.object({
  totalGaps: z.number(),
  relations: z.number(),
  maxSeverity: z.enum(['high', 'medium', 'low', 'none']),
  chains: z.number(),
  pendingDrafts: z.number(),
  draftRelations: z.number(),
});

export const briefingSchema = z.object({
  date: z.string(),
  stats: briefingStatsSchema,
  contentMd: z.string(),
});

export type Briefing = z.infer<typeof briefingSchema>;

export async function fetchLatestBriefing(options: {
  apiBaseUrl: string;
  token: string;
  fetch?: typeof fetch;
}): Promise<Briefing> {
  return requestBriefing(
    '/briefings/latest',
    options,
    () => new BriefingError('no briefing available yet (briefings are generated daily)'),
  );
}

export async function fetchBriefingForDate(options: {
  apiBaseUrl: string;
  token: string;
  date: string;
  fetch?: typeof fetch;
}): Promise<Briefing> {
  return requestBriefing(
    `/briefings/${encodeURIComponent(options.date)}`,
    options,
    () => new BriefingNotFoundError(options.date),
  );
}

async function requestBriefing(
  path: string,
  options: { apiBaseUrl: string; token: string; fetch?: typeof fetch },
  onNotFound: () => BriefingError,
): Promise<Briefing> {
  const fetchFn = options.fetch ?? fetch;
  const base = options.apiBaseUrl.replace(/\/+$/, '');
  warnCleartextApiUrl(base);
  let response: Response;
  try {
    response = await fetchFn(`${base}${path}`, {
      headers: { Authorization: `Bearer ${options.token}` },
      // Same-origin redirects must not replay the token (review P2 hardening).
      redirect: 'error',
    });
  } catch {
    throw new BriefingError(`cannot reach the Helm Agent server at ${base} (is it running?)`);
  }
  if (response.status === 401) {
    throw new BriefingError('the server rejected the API token (check --token / PHELM_API_TOKEN)');
  }
  if (response.status === 503) {
    throw new BriefingError(
      'the server has briefing endpoints disabled (API_AUTH_TOKEN unconfigured)',
    );
  }
  if (response.status === 404) {
    throw onNotFound();
  }
  if (!response.ok) {
    throw new BriefingError(`fetching the briefing failed with status ${response.status}`);
  }
  const parsed = briefingSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new BriefingError('the server returned an unexpected briefing payload');
  }
  return parsed.data;
}

/** Today's date in UTC (YYYY-MM-DD), matching the server's briefing day boundary. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** ---------- output (stdout must stay byte-identical to contentMd) ---------- */

export interface BriefingStreams {
  out: (text: string) => void;
  err: (text: string) => void;
}

/**
 * Meta line to stderr, briefing body verbatim to stdout — zero
 * transformation: no prefix, no added trailing newline, no coloring.
 */
export function printBriefing(briefing: Briefing, streams: BriefingStreams): void {
  streams.err(`briefing for ${briefing.date}`);
  streams.out(briefing.contentMd);
}
