import { z } from 'zod';

/**
 * Board fetching + terminal rendering for `phelm board` (T-0016).
 *
 * The CLI validates the server response against the same shape the api
 * publishes, then renders pure text/ANSI — rendering is a pure function
 * (data in, string out) so it is testable offline. Colors auto-disable for
 * non-TTY output and NO_COLOR, per the no-color convention.
 */

export class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardError';
  }
}

const snapshotSchema = z.object({
  date: z.string(),
  healthScore: z.number(),
  // T-0017: a factor with no real signal is reported as `null`, not as a
  // neutral number. Validating it as `z.number()` here would reject the WHOLE
  // board payload — one honestly-unknown factor would make `phelm board` fail
  // for every project.
  factors: z.record(z.string(), z.number().nullable()),
  summary: z.string(),
});

const ciSchema = z.object({
  status: z.string(),
  branch: z.string(),
  lastConclusion: z.string().nullable(),
  lastRunTs: z.string().nullable(),
  failingSince: z.string().nullable(),
  consecutiveFailures: z.number(),
});

const milestonesSchema = z.object({
  count: z.number(),
  averageProgress: z.number(),
  nearestDueDate: z.string().nullable(),
});

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
      snapshot: snapshotSchema.nullable(),
      ci: ciSchema.nullable(),
      milestones: milestonesSchema.nullable(),
      risks: z.array(z.object({ type: z.string(), level: z.string(), impact: z.string() })),
    }),
  ),
});

export type Board = z.infer<typeof boardSchema>;

export type BoardProject = Board['projects'][number];

/**
 * Cleartext http to a non-loopback host would put the bearer token on the
 * wire unencrypted (review P2 hardening): warn once per call on stderr and
 * continue — the operator decides. Shared by board/brief/github-api.
 */
export function warnCleartextApiUrl(
  base: string,
  err: (line: string) => void = console.error,
): void {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return; // invalid base fails later at fetch with a clearer error
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]' ||
    url.hostname.endsWith('.localhost');
  if (url.protocol === 'http:' && !loopback) {
    err(
      `phelm: warning: --api uses cleartext http (${base}); the API token travels unencrypted — use https or a loopback address`,
    );
  }
}

export async function fetchBoard(options: {
  apiBaseUrl: string;
  token: string;
  fetch?: typeof fetch;
}): Promise<Board> {
  const fetchFn = options.fetch ?? fetch;
  const base = options.apiBaseUrl.replace(/\/+$/, '');
  warnCleartextApiUrl(base);
  let response: Response;
  try {
    response = await fetchFn(`${base}/board`, {
      headers: { Authorization: `Bearer ${options.token}` },
      // Same-origin redirects must not replay the token (review P2 hardening).
      redirect: 'error',
    });
  } catch {
    throw new BoardError(`cannot reach the Helm Agent server at ${base} (is it running?)`);
  }
  if (response.status === 401) {
    throw new BoardError('the server rejected the API token (check --token / PHELM_API_TOKEN)');
  }
  if (response.status === 503) {
    throw new BoardError('the server has board endpoints disabled (API_AUTH_TOKEN unconfigured)');
  }
  if (!response.ok) {
    throw new BoardError(`fetching the board failed with status ${response.status}`);
  }
  const parsed = boardSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new BoardError('the server returned an unexpected board payload');
  }
  return parsed.data;
}

/** ---------- rendering (pure; colors decided by the caller) ---------- */

export type HealthColor = 'green' | 'yellow' | 'red' | 'gray';

export function healthColor(score: number | undefined): HealthColor {
  if (score === undefined) {
    return 'gray';
  }
  if (score >= 80) return 'green';
  if (score >= 50) return 'yellow';
  return 'red';
}

export function ciColor(status: string | undefined): HealthColor {
  if (status === 'passing') return 'green';
  if (status === 'failing') return 'red';
  return 'gray';
}

const ANSI: Record<HealthColor, string> = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};
const RESET = '\x1b[0m';

/** `█████░░░░░` 10-cell progress bar. */
export function progressBar(progressPercent: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(progressPercent)));
  const filled = Math.round(clamped / 10);
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

export function colorize(text: string, color: HealthColor, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${text}${RESET}` : text;
}

export function renderBoard(board: Board, options: { colors: boolean }): string {
  const lines: string[] = [];
  for (const project of board.projects) {
    const health = project.snapshot?.healthScore;
    const healthDot = colorize('●', healthColor(health), options.colors);
    const ciDot = colorize('●', ciColor(project.ci?.status), options.colors);
    const score = health === undefined ? '-' : String(health).padStart(3, ' ');

    let milestone = 'no milestones';
    if (project.milestones !== null && project.milestones.count > 0) {
      const bar = colorize(progressBar(project.milestones.averageProgress), 'gray', options.colors);
      milestone = `${bar} ${Math.round(project.milestones.averageProgress)}% (${project.milestones.count} ms)`;
    }

    lines.push(`${healthDot} ${score}  ${ciDot}  ${project.name}  (${project.repo})`);
    lines.push(`    ${project.stage} · ${project.priority} · ${milestone}`);

    if (project.ci?.status === 'failing' && project.ci.failingSince !== null) {
      lines.push(
        `    CI red since ${project.ci.failingSince.slice(0, 16).replace('T', ' ')} (${project.ci.consecutiveFailures} in a row)`,
      );
    }
    for (const risk of project.risks) {
      lines.push(`    risk [${risk.level}] ${risk.type}: ${risk.impact}`);
    }
    lines.push(`    ${project.snapshot?.summary ?? 'no snapshot yet'}`);
  }
  if (board.projects.length === 0) {
    lines.push('No tracked projects yet. Import one with: phelm repos import <owner/name>');
  }
  return lines.join('\n');
}
