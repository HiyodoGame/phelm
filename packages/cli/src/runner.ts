import { spawn } from 'node:child_process';
import {
  RunnerReportSchema,
  TaskSchema,
  defaultBranchFor,
  type RunnerReport,
  type Task,
  type TaskSpec,
} from '@phelm/contract';

/**
 * `phelm runner` (T-0038, dispatch channel B): a long-running loop on the
 * operator's machine that claims tasks from the Helm Agent server, runs the
 * local agent CLI headless, and reports the outcome back. The claim and the
 * report are operator-authenticated writes; the agent command template and
 * its credentials never leave this machine.
 *
 * Injection surface (design decision 6): the agent template is spawned with
 * `shell: true` so it stays the operator's own command line, but ALL task
 * data (the rendered prompt) reaches the agent exclusively through stdin —
 * never argv, never the shell string. A goal containing quotes, `$` or
 * backticks must arrive byte-for-byte uninterpreted.
 *
 * Reliability posture (design decisions 9-10): transient server/network
 * failures are retried with exponential backoff and then given up loudly —
 * a claim failure idles into the next cycle, a report failure leaves the
 * task in its server-side state. SIGINT/SIGTERM finish the current cycle
 * (report included) before exiting. The token only ever travels inside the
 * Authorization header and never appears in logs or error messages.
 *
 * FATAL classification (review P1): some errors cannot heal within this
 * process's lifetime — the agent template failing to spawn (a permanent
 * local misconfiguration), a claim 401 (the token will not fix itself) and
 * an unparsable claim payload (a server-side contract break, P2-6 family).
 * Retrying or looping on them is worse than useless: every further cycle
 * would fail the same way, and a spawn fatal in particular would drain the
 * whole ready board into dispatched-with-no-result rows (no un-dispatch
 * path until T-0039). So a fatal cycle marks its result and the loop
 * CIRCUIT-BREAKS: exit non-zero with an operator-facing explanation, the
 * fix happens outside the process, the operator restarts. An agent process
 * that merely exits non-zero is NOT fatal — that is an ordinary task
 * outcome (reported back, loop continues).
 */

/** A runner error that is either transient (default) or `fatal` (permanent
 * local misconfiguration — see the module comment; `withRetries` never
 * retries a fatal and the loop circuit-breaks on one). */
export class RunnerError extends Error {
  readonly fatal: boolean;

  constructor(message: string, options: { fatal?: boolean } = {}) {
    super(message);
    this.name = 'RunnerError';
    this.fatal = options.fatal === true;
  }
}

/** Report retries after the initial attempt (design decision 9). */
export const REPORT_RETRIES = 3;
/** Exponential backoff start for the retry sequence: 500ms, 1s, 2s. */
export const RETRY_BASE_MS = 500;

/** Last-N-chars cap for the agent output tail sent back to the server. */
export const LOG_TAIL_MAX_CHARS = 8192;

export interface RunnerOptions {
  apiBaseUrl: string;
  token: string;
  /** Shell command template that runs the agent; the prompt goes to stdin. */
  agentTemplate: string;
  intervalSeconds: number;
  /** Run exactly one claim cycle, then exit (smoke tests / cron). */
  once: boolean;
}

export interface SpawnedAgent {
  exitCode: number;
  output: string;
}

export interface RunnerDeps {
  fetch?: typeof fetch;
  /** Defaults to the real shell spawn; tests inject a fake. */
  spawnAgent?: (template: string, prompt: string) => Promise<SpawnedAgent>;
  /** Defaults to a plain timer sleep; tests inject an immediate one. */
  sleep?: (ms: number) => Promise<void>;
  /** True once a shutdown signal has been observed (graceful exit). */
  stopped?: () => boolean;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** One claim cycle's outcome (`failed` = the cycle never got to report).
 * `fatal` (review P1) marks a permanent local misconfiguration the loop
 * must circuit-break on instead of idling into the next cycle:
 * - `'spawn'`: the agent template failed to spawn (the claimed task still
 *   gets its fabricated -1 run reported, then the loop stops);
 * - `'claim'`: the claim failed without any chance of self-healing (401 /
 *   unparsable payload) — nothing was claimed. */
export interface RunOnceResult {
  outcome: 'claimed' | 'idle' | 'failed';
  fatal?: 'spawn' | 'claim';
  taskId?: string;
  exitCode?: number;
  prUrl?: string;
}

export interface RunRunnerResult {
  /** False when at least one cycle failed (drives the CLI exit code). */
  ok: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the error is a RunnerError marked fatal (review P1). */
function isFatalError(error: unknown): boolean {
  return error instanceof RunnerError && error.fatal;
}

/** ---------- prompt rendering (pure; design decision 7) ---------- */

function bulletList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * The English instruction block sent to the agent on stdin. The task's user
 * data (goal, files, constraints, acceptance) is rendered VERBATIM — the
 * prompt is an output stream for the agent to read, not a surface anything
 * parses, so no delimiting or escaping applies (unlike the issue-relay body,
 * which GitHub does parse and therefore sanitizes its marker lines).
 */
export function renderPrompt(spec: TaskSpec): string {
  const branch = spec.branch ?? defaultBranchFor(spec.taskId);
  const sections = [
    'You are completing a Helm task end to end on this machine. Work autonomously.',
    '',
    `Task: ${spec.taskId}`,
    `Project: ${spec.project}`,
    `Repository: ${spec.repo}`,
    `Branch: work on \`${branch}\`; create it from the default branch if it does not exist yet.`,
    `Limits: noDirectPushToMain=${spec.limits.noDirectPushToMain}, requirePr=${spec.limits.requirePr} — never push directly to main.`,
    ...(spec.limits.maxDurationMinutes === undefined
      ? []
      : [`Time budget: ${spec.limits.maxDurationMinutes} minutes.`]),
    '',
    '## Goal',
    '',
    spec.goal,
    '',
  ];
  if (spec.context.files.length > 0) {
    sections.push('## Files to consult first', '', bulletList(spec.context.files), '');
  }
  if (spec.context.constraints.length > 0) {
    sections.push('## Constraints', '', bulletList(spec.context.constraints), '');
  }
  sections.push(
    '## Acceptance criteria',
    '',
    spec.acceptance.length === 0 ? '(none listed)' : bulletList(spec.acceptance),
    '',
    '## Wrap-up',
    '',
    `Self-check your work against every acceptance criterion before finishing. When done, open a pull request from \`${branch}\` on ${spec.repo} whose description contains the exact line \`Helm-Task: ${spec.taskId}\` on its own line, then print the pull request URL as the last line of your output.`,
  );
  return sections.join('\n');
}

/** ---------- output post-processing (pure) ---------- */

const PR_URL_PATTERN = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

/**
 * HEURISTIC (design decision 8): take the LAST pull-request URL in the
 * agent's merged output. Agents tend to print comparison links before the
 * final one, and the wrap-up instruction asks for the PR URL as the last
 * output line. The heuristic is known to be limited in BOTH directions:
 * - false negative: the agent never prints the URL — the report carries
 *   none and the task stays dispatched; a human must read the log.
 * - false positive (review P2-5): the goal text, the agent's own echoed
 *   logs, or a "related PR" mention can carry a DIFFERENT PR-shaped URL;
 *   if any of those lands AFTER the real URL, the echo is taken as the
 *   prUrl and mis-attributes the task. Nothing downstream parses the URL
 *   beyond storing it, but it is displayed as the task's PR — an operator
 *   reconciling via the webhook path is not affected (the webhook records
 *   the PR it actually observed).
 */
export function extractPrUrl(output: string): string | undefined {
  const matches = [...output.matchAll(PR_URL_PATTERN)];
  return matches[matches.length - 1]?.[0];
}

/**
 * The last `maxChars` characters of the merged output. When the cut lands
 * between the two halves of a surrogate pair, the dangling LOW half at the
 * START of the tail is dropped (a low surrogate can never open a valid
 * sequence) — the mirror image of the issue-relay's trailing-half trim
 * (T-0037 P2-1), which cuts from the front and fixes the tail.
 */
export function logTail(output: string, maxChars = LOG_TAIL_MAX_CHARS): string {
  if (output.length <= maxChars) {
    return output;
  }
  const tail = output.slice(output.length - maxChars);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/** ---------- process generation (design decision 6 — the red line) ---------- */

/**
 * Spawn the agent template with `shell: true` and feed the prompt to its
 * stdin. The prompt NEVER enters argv or the shell string, so task data
 * (which comes from a user's charter and may contain quotes, `$`, backticks
 * or newlines) reaches the agent byte-for-byte uninterpreted. Stdout and
 * stderr are captured merged (order interleaved) for the PR heuristic and
 * the log tail. A child killed by a signal reports exitCode null in node —
 * recorded as the -1 sentinel (design decision 9).
 */
export function spawnAgentProcess(template: string, prompt: string): Promise<SpawnedAgent> {
  return new Promise((resolve, reject) => {
    const child = spawn(template, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    // A child that closes its pipe before consuming the prompt must not
    // crash the runner with an unhandled EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exitCode: code ?? -1, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/** ---------- server calls ---------- */

/**
 * Hard ceiling for one server round-trip. Without it a half-open connection
 * (server died mid-request, NAT drop) hangs the fetch forever: the cycle
 * never completes and SIGINT only wakes the idle sleep, not a pending fetch
 * (review P1 fix — the MCP client already had a 30s timeout; the runner's
 * long-lived loop needs it even more).
 */
const SERVER_TIMEOUT_MS = 30_000;

async function apiFetch(
  deps: RunnerDeps,
  options: RunnerOptions & { path: string; method: 'POST'; body?: unknown },
): Promise<Response> {
  const fetchFn = deps.fetch ?? fetch;
  const base = options.apiBaseUrl.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetchFn(`${base}${options.path}`, {
      method: options.method,
      headers: {
        // The token's only appearance on the wire; never logged anywhere.
        Authorization: `Bearer ${options.token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      // A timeout abort rejects like any network failure → the catch below
      // maps it to a (retryable) RunnerError.
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    });
  } catch {
    throw new RunnerError(`cannot reach the Helm Agent server at ${base} (is it running?)`);
  }
  if (response.status === 401) {
    // The token cannot heal within this process's lifetime (review P1-2).
    throw new RunnerError('the server rejected the API token (check --token / PHELM_API_TOKEN)', {
      fatal: true,
    });
  }
  return response;
}

/**
 * Claim the oldest ready task. 204 means "nothing to do" (idle); 200 is a
 * contract Task (parsed — the board fetch precedent of validating server
 * responses against the contract).
 */
async function claimTask(deps: RunnerDeps, options: RunnerOptions): Promise<Task | undefined> {
  const response = await apiFetch(deps, { ...options, path: '/tasks/claim', method: 'POST' });
  if (response.status === 204) {
    return undefined;
  }
  if (!response.ok) {
    throw new RunnerError(`claiming a task failed with status ${response.status}`);
  }
  const parsed = TaskSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    // A payload that breaks the contract is a server-side problem the
    // process cannot out-wait (review P1-2, P2-6 family): retrying would
    // parse the same bytes.
    throw new RunnerError('the server returned an unexpected claim payload', { fatal: true });
  }
  return parsed.data;
}

async function sendReport(
  deps: RunnerDeps,
  options: RunnerOptions,
  report: RunnerReport,
): Promise<void> {
  // The report is built by this process, so a schema violation is a local
  // deterministic bug — retrying re-parses the same bytes (review: the raw
  // ZodError escaped withRetries' fatal handling and burned 3 retries plus
  // a multi-line dump on the operator).
  const parsed = RunnerReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new RunnerError(
      `runner report rejected by the contract schema: ${parsed.error.issues
        .map((issue) => issue.path.join('.') || '(root)')
        .join(', ')}`,
      { fatal: true },
    );
  }
  const body = parsed.data;
  const response = await apiFetch(deps, {
    ...options,
    path: `/tasks/${body.taskId}/runner-report`,
    method: 'POST',
    body,
  });
  if (!response.ok) {
    throw new RunnerError(`reporting task ${body.taskId} failed with status ${response.status}`);
  }
}

/** Run `run` with the pinned retry policy: 1 initial attempt + 3 retries,
 * exponential backoff from 500ms. The LAST error is rethrown — except a
 * FATAL RunnerError (review P1-2), which is rethrown immediately: retrying
 * a permanent misconfiguration (401, unparsable payload) only burns the
 * backoff. */
async function withRetries<T>(deps: RunnerDeps, run: () => Promise<T>): Promise<T> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt <= REPORT_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (isFatalError(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}

/** ---------- the loop ---------- */

export async function runOnce(
  options: RunnerOptions,
  deps: RunnerDeps = {},
): Promise<RunOnceResult> {
  const out = deps.out ?? ((text: string) => process.stdout.write(`${text}\n`));
  const err = deps.err ?? ((text: string) => console.error(text));

  let task: Task | undefined;
  try {
    task = await withRetries(deps, () => claimTask(deps, options));
  } catch (error) {
    if (isFatalError(error)) {
      // Claim fatal (review P1-2): 401 / unparsable payload will not heal
      // within this process — say why (the message carries the fix hint);
      // the loop circuit-breaks on the fatal marker.
      err(`claim failed (fatal): ${errorMessage(error)}`);
      return { outcome: 'failed', fatal: 'claim' };
    }
    err(`claim failed after ${REPORT_RETRIES} retries: ${errorMessage(error)}`);
    return { outcome: 'failed' };
  }
  if (task === undefined) {
    out('no ready tasks (idle)');
    return { outcome: 'idle' };
  }

  out(`claimed ${task.id} (${task.spec.repo})`);
  const prompt = renderPrompt(task.spec);
  let agent: SpawnedAgent;
  let spawnFatal = false;
  try {
    const spawnAgent = deps.spawnAgent ?? spawnAgentProcess;
    agent = await spawnAgent(options.agentTemplate, prompt);
  } catch (error) {
    // Spawn-level failure (the shell could not even start — ENOENT etc.) is
    // a PERMANENT local misconfiguration, not a task outcome (review P1-1).
    // The claimed task still gets its fabricated -1 run reported so the row
    // carries the reason instead of stranding silently, and the cycle is
    // marked fatal so the loop CIRCUIT-BREAKS: without the break every
    // further cycle would spawn-fail again and drain the ready board into
    // dispatched rows (no un-dispatch path until T-0039).
    agent = { exitCode: -1, output: `runner error: ${errorMessage(error)}` };
    spawnFatal = true;
    err(`fatal: the agent command template failed to spawn: ${errorMessage(error)}`);
  }

  const prUrl = extractPrUrl(agent.output);
  const tail = logTail(agent.output);
  const report = {
    taskId: task.id,
    exitCode: agent.exitCode,
    ...(prUrl === undefined ? {} : { prUrl }),
    // The contract demands a non-empty tail; a fully silent agent reports
    // the honest placeholder instead of failing validation.
    logTail: tail === '' ? '(no output)' : tail,
  };
  try {
    await withRetries(deps, () => sendReport(deps, options, report));
  } catch (error) {
    // Design decision 9: retries exhausted (or a fatal that was never
    // retried, e.g. a 401) — warn loudly and leave the task in its
    // server-side state (a webhook PR-opened can still reconcile it). The
    // loop continues either way: if the token is broken the NEXT claim
    // fails fatally and circuit-breaks there.
    err(
      isFatalError(error)
        ? `warning: reporting task ${task.id} failed (fatal): ${errorMessage(error)}; the task stays in its server-side state`
        : `warning: reporting task ${task.id} failed after ${REPORT_RETRIES} retries: ${errorMessage(error)}; the task stays in its server-side state`,
    );
  }
  out(
    `task ${task.id}: agent exited with ${agent.exitCode}${prUrl === undefined ? '' : `, PR ${prUrl}`}`,
  );
  return {
    outcome: 'claimed',
    taskId: task.id,
    exitCode: agent.exitCode,
    prUrl,
    ...(spawnFatal ? { fatal: 'spawn' as const } : {}),
  };
}

/**
 * The runner loop: claim → run → report, idling `intervalSeconds` between
 * cycles. SIGINT/SIGTERM (production runtime) finish the current cycle,
 * report included, then exit; `--once` runs a single cycle and exits.
 */
export async function runRunner(
  options: RunnerOptions,
  deps: RunnerDeps = {},
): Promise<RunRunnerResult> {
  if (options.agentTemplate === '') {
    throw new RunnerError(
      'missing --agent <template>: pass the shell command that runs your agent headless (or set PHELM_RUNNER_AGENT)',
    );
  }
  const runtime =
    deps.sleep === undefined && deps.stopped === undefined
      ? createProcessRuntime()
      : {
          stopped: deps.stopped ?? (() => false),
          sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
          dispose: () => {},
        };
  const out = deps.out ?? ((text: string) => process.stdout.write(`${text}\n`));
  const err = deps.err ?? ((text: string) => console.error(text));
  try {
    out(
      options.once
        ? 'runner: running a single claim cycle'
        : `runner: polling every ${options.intervalSeconds}s (Ctrl+C to stop after the current cycle)`,
    );
    let ok = true;
    for (;;) {
      const result = await runOnce(options, { ...deps, sleep: runtime.sleep });
      if (result.outcome === 'failed' || result.fatal !== undefined) {
        ok = false;
      }
      if (result.fatal !== undefined) {
        // Circuit break (review P1): a fatal is a permanent local
        // misconfiguration — the agent template cannot spawn, or the claim
        // cannot succeed (401 / unparsable payload). Every further cycle
        // would fail the same way (a spawn fatal would drain the ready
        // board into dispatched rows; there is no un-dispatch path before
        // T-0039), so stop instead of idling into the next cycle. The fix
        // happens outside this process; the operator restarts.
        err(
          result.fatal === 'spawn'
            ? 'runner configuration error tripped the circuit breaker; fix the --agent template and restart (fatal; the runner stops)'
            : 'runner configuration error tripped the circuit breaker; fix the configuration and restart (fatal; the runner stops): see the fatal error above',
        );
        break;
      }
      if (options.once || runtime.stopped()) {
        break;
      }
      await runtime.sleep(options.intervalSeconds * 1000);
      if (runtime.stopped()) {
        break;
      }
    }
    out('runner stopped');
    return { ok };
  } finally {
    runtime.dispose();
  }
}

/**
 * Production runtime: SIGINT/SIGTERM flip the stop flag and wake a pending
 * idle sleep so the runner exits promptly after the current cycle (design
 * decision 10) instead of sitting out the full interval. Exported for tests;
 * tests normally inject their own deps. The dispose() removes the listeners.
 */
export function createProcessRuntime(): {
  stopped: () => boolean;
  sleep: (ms: number) => Promise<void>;
  dispose: () => void;
} {
  const waiters = new Set<() => void>();
  const state = { stop: false };
  const onSignal = () => {
    state.stop = true;
    for (const wake of waiters) {
      wake();
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return {
    stopped: () => state.stop,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        if (state.stop) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          waiters.delete(wake);
          resolve();
        }, ms);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        waiters.add(wake);
      }),
    dispose: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

/** Parse the `--interval <seconds>` flag value; undefined = invalid. */
export function parseIntervalSeconds(raw: string): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
