import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Task } from '@phelm/contract';
import {
  LOG_TAIL_MAX_CHARS,
  REPORT_RETRIES,
  RunnerError,
  createProcessRuntime,
  extractPrUrl,
  logTail,
  parseIntervalSeconds,
  renderPrompt,
  runOnce,
  runRunner,
  spawnAgentProcess,
  type RunnerDeps,
  type RunnerOptions,
} from './runner.js';

/**
 * The runner is tested with injected deps (fake fetch + fake spawn) so no
 * test touches the network, plus a handful of REAL spawn cases for the
 * process-generation red line (design decision 6): the prompt travels to the
 * child's stdin only, byte-for-byte, while argv carries the static template.
 */

const OPTIONS: RunnerOptions = {
  apiBaseUrl: 'http://api.test',
  token: 'tok-1234567890',
  agentTemplate: 'agent-run --headless',
  intervalSeconds: 30,
  once: true,
};

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps & {
  fetchCalls: Array<{ url: string; init: RequestInit }>;
  spawned: Array<{ template: string; prompt: string }>;
  outLines: string[];
  errLines: string[];
  sleeps: number[];
} {
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const spawned: Array<{ template: string; prompt: string }> = [];
  const outLines: string[] = [];
  const errLines: string[] = [];
  const sleeps: number[] = [];
  return {
    fetchCalls,
    spawned,
    outLines,
    errLines,
    sleeps,
    fetch: (async (url: unknown, init: unknown) => {
      fetchCalls.push({ url: String(url), init: init as RequestInit });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    spawnAgent: async (template: string, prompt: string) => {
      spawned.push({ template, prompt });
      return { exitCode: 0, output: 'all good' };
    },
    sleep: (async (ms: number) => {
      sleeps.push(ms);
    }) as (ms: number) => Promise<void>,
    out: (text: string) => outLines.push(text),
    err: (text: string) => errLines.push(text),
    ...overrides,
  };
}

const GOAL_WITH_METACHARACTERS =
  'Fix the parser for "quoted strings", values like $HOME and `cmd`, plus\nmulti-line\r\ntext — and an emoji: 😀';

function taskBody(overrides: Partial<Task> = {}): unknown {
  return {
    id: 'T-0042',
    projectId: 'proj-1',
    spec: {
      taskId: 'T-0042',
      project: 'proj-1',
      repo: 'octo/repo',
      goal: GOAL_WITH_METACHARACTERS,
      context: { issues: [], files: ['src/a.ts'], constraints: ['no new deps'] },
      acceptance: ['parser handles quotes'],
      targetAgent: 'zcode',
      limits: { noDirectPushToMain: true, requirePr: true },
    },
    targetAgent: 'zcode',
    channel: 'cli_runner',
    status: 'dispatched',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterAll(() => {
  vi.restoreAllMocks();
});

describe('renderPrompt', () => {
  const spec = (taskBody() as { spec: Task['spec'] }).spec;

  it('renders branch, goal, constraints, acceptance, limits and the marker line', () => {
    const prompt = renderPrompt(spec);
    expect(prompt).toContain('`helm/T-0042`'); // defaultBranchFor
    expect(prompt).toContain(GOAL_WITH_METACHARACTERS); // verbatim
    expect(prompt).toContain('- src/a.ts');
    expect(prompt).toContain('- no new deps');
    expect(prompt).toContain('- parser handles quotes');
    expect(prompt).toContain('noDirectPushToMain=true, requirePr=true');
    expect(prompt).toContain('never push directly to main');
    expect(prompt).toContain('`Helm-Task: T-0042`');
    expect(prompt).toContain('print the pull request URL as the last line');
  });

  it('honors a spec branch override and the time budget when present', () => {
    const prompt = renderPrompt({
      ...spec,
      branch: 'helm/T-0042-custom',
      limits: { noDirectPushToMain: true, requirePr: true, maxDurationMinutes: 45 },
    });
    expect(prompt).toContain('`helm/T-0042-custom`');
    expect(prompt).toContain('Time budget: 45 minutes.');
  });

  it('renders the safety limits faithfully when they are relaxed', () => {
    const prompt = renderPrompt({
      ...spec,
      limits: { noDirectPushToMain: false, requirePr: false },
    });
    expect(prompt).toContain('noDirectPushToMain=false, requirePr=false');
  });
});

describe('extractPrUrl', () => {
  it('returns the LAST pull request url in the output', () => {
    const output = [
      'compare https://github.com/octo/repo/pull/7 first mention',
      'also https://github.com/octo/repo/issues/11 is not a PR',
      'opened: https://github.com/octo/repo/pull/12 thanks',
    ].join('\n');
    expect(extractPrUrl(output)).toBe('https://github.com/octo/repo/pull/12');
  });

  it('returns undefined when no pull request url appears', () => {
    expect(extractPrUrl('done, but silent about PRs')).toBeUndefined();
  });
});

describe('logTail', () => {
  it('passes short output through untouched', () => {
    expect(logTail('short', LOG_TAIL_MAX_CHARS)).toBe('short');
  });

  it('keeps the LAST maxChars characters of long output', () => {
    const output = `head-${'x'.repeat(20_000)}-tail-marker`;
    const tail = logTail(output);
    expect(tail).toHaveLength(LOG_TAIL_MAX_CHARS);
    expect(tail.endsWith('-tail-marker')).toBe(true);
  });

  it('drops a dangling low surrogate at the cut boundary', () => {
    // '😀' sits at code units 10-11; sizing the string so the 8192-window
    // starts exactly on the LOW half (index 11).
    const output = `${'a'.repeat(10)}\u{1F600}${'b'.repeat(8191)}`;
    expect(output.length).toBe(8203);
    const tail = logTail(output);
    expect(tail).toBe('b'.repeat(8191));
  });

  it('keeps a surrogate pair that ends whole inside the window', () => {
    // The window starts on the HIGH half: the pair travels intact.
    const output = `${'a'.repeat(10)}\u{1F600}${'b'.repeat(8190)}`;
    expect(output.length).toBe(8202);
    const tail = logTail(output);
    expect(tail).toBe(`\u{1F600}${'b'.repeat(8190)}`);
  });
});

describe('parseIntervalSeconds', () => {
  it('accepts positive integers and rejects the rest', () => {
    expect(parseIntervalSeconds('30')).toBe(30);
    expect(parseIntervalSeconds('0')).toBeUndefined();
    expect(parseIntervalSeconds('-5')).toBeUndefined();
    expect(parseIntervalSeconds('1.5')).toBeUndefined();
    expect(parseIntervalSeconds('soon')).toBeUndefined();
  });
});

describe('spawnAgentProcess (real spawn)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phelm-runner-spawn-'));
  const echoScript = join(dir, 'echo-stdin.mjs');
  writeFileSync(echoScript, 'process.stdin.pipe(process.stdout);\n');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers the prompt to stdin byte-for-byte; argv stays static', async () => {
    // The template is the operator's command line (static parts only); the
    // metacharacter bomb must arrive through stdin uninterpreted.
    const template = `node "${echoScript}"`;
    const result = await spawnAgentProcess(template, GOAL_WITH_METACHARACTERS);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(GOAL_WITH_METACHARACTERS);
  });

  it('merges stderr into the captured output and maps exit codes', async () => {
    const toStderr = join(dir, 'to-stderr.mjs');
    writeFileSync(toStderr, "process.stderr.write('to stderr'); process.exitCode = 3;\n");
    const result = await spawnAgentProcess(`node "${toStderr}"`, 'prompt');
    expect(result.exitCode).toBe(3);
    expect(result.output).toBe('to stderr');
  });

  it('records the -1 sentinel when a signal kills the process (posix only)', async () => {
    if (process.platform === 'win32') {
      return; // Windows termination has no null exit code / signal semantics
    }
    const killShell = join(dir, 'kill-shell.mjs');
    writeFileSync(killShell, "process.kill(process.ppid, 'SIGKILL');\n");
    const result = await spawnAgentProcess(`node "${killShell}"`, 'prompt');
    expect(result.exitCode).toBe(-1);
  });
});

describe('runOnce', () => {
  it('idles on 204 without spawning an agent or reporting', async () => {
    const deps = makeDeps();
    const result = await runOnce(OPTIONS, deps);
    expect(result).toEqual({ outcome: 'idle' });
    expect(deps.fetchCalls).toHaveLength(1);
    expect(deps.spawned).toHaveLength(0);
    expect(deps.outLines.at(-1)).toBe('no ready tasks (idle)');
  });

  it('claims, renders the prompt and spawns the agent with the template untouched', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        deps.fetchCalls.push({ url: String(url), init: init as RequestInit });
        return jsonResponse(taskBody());
      }) as typeof fetch,
    });
    const result = await runOnce(OPTIONS, deps);

    expect(result.outcome).toBe('claimed');
    expect(deps.spawned).toHaveLength(1);
    // argv carries ONLY the operator's template; the task data is the
    // separate stdin argument, never spliced into the command line.
    expect(deps.spawned[0]!.template).toBe('agent-run --headless');
    expect(deps.spawned[0]!.prompt).toBe(renderPrompt((taskBody() as Task).spec));
    expect(deps.spawned[0]!.prompt).toContain(GOAL_WITH_METACHARACTERS);
  });

  it('reports the last PR url, the exit code and the log tail; token stays in the header', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        const call = { url: String(url), init: init as RequestInit };
        deps.fetchCalls.push(call);
        if (call.url.endsWith('/tasks/claim')) {
          return jsonResponse(taskBody());
        }
        return jsonResponse(taskBody({ status: 'pr_opened' }));
      }) as typeof fetch,
      spawnAgent: async () => ({
        exitCode: 0,
        output: [
          'work done',
          `compare https://github.com/octo/repo/pull/7`,
          'PR: https://github.com/octo/repo/pull/12',
          'trailing noise'.repeat(100),
        ].join('\n'),
      }),
    });
    const result = await runOnce(OPTIONS, deps);

    expect(result).toMatchObject({
      outcome: 'claimed',
      taskId: 'T-0042',
      exitCode: 0,
      prUrl: 'https://github.com/octo/repo/pull/12',
    });
    const reportCall = deps.fetchCalls.at(-1)!;
    expect(reportCall.url).toBe('http://api.test/tasks/T-0042/runner-report');
    expect(reportCall.init.method).toBe('POST');
    expect((reportCall.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${OPTIONS.token}`,
    );
    const body = JSON.parse(String(reportCall.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      taskId: 'T-0042',
      exitCode: 0,
      prUrl: 'https://github.com/octo/repo/pull/12',
    });
    expect(String(body.logTail)).toContain('trailing noise');
    // The token never leaks into the console output.
    for (const line of [...deps.outLines, ...deps.errLines]) {
      expect(line).not.toContain(OPTIONS.token);
    }
  });

  it('reports WITHOUT a prUrl when the agent printed none', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        deps.fetchCalls.push({ url: String(url), init: init as RequestInit });
        return jsonResponse(taskBody());
      }) as typeof fetch,
      spawnAgent: async () => ({ exitCode: 1, output: 'failed loudly' }),
    });
    const result = await runOnce(OPTIONS, deps);

    expect(result.outcome).toBe('claimed');
    expect(result.exitCode).toBe(1);
    expect(result.prUrl).toBeUndefined();
    expect(result.fatal).toBeUndefined(); // a non-zero EXIT is a task outcome, not fatal
    const body = JSON.parse(String(deps.fetchCalls.at(-1)!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ taskId: 'T-0042', exitCode: 1, logTail: 'failed loudly' });
    expect(body.prUrl).toBeUndefined();
  });

  it('maps a fully silent agent to the honest empty-output tail', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        deps.fetchCalls.push({ url: String(url), init: init as RequestInit });
        return jsonResponse(taskBody());
      }) as typeof fetch,
      spawnAgent: async () => ({ exitCode: 0, output: '' }),
    });
    await runOnce(OPTIONS, deps);
    const body = JSON.parse(String(deps.fetchCalls.at(-1)!.init.body)) as Record<string, unknown>;
    expect(body.logTail).toBe('(no output)');
  });

  it('retries a failing report 3 times with exponential backoff, then gives up with a warning', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        const call = { url: String(url), init: init as RequestInit };
        deps.fetchCalls.push(call);
        if (call.url.endsWith('/tasks/claim')) {
          return jsonResponse(taskBody());
        }
        return new Response('nope', { status: 500 });
      }) as typeof fetch,
    });
    const result = await runOnce(OPTIONS, deps);

    expect(result.outcome).toBe('claimed'); // the cycle still completes
    const reportCalls = deps.fetchCalls.filter((call) => call.url.endsWith('/runner-report'));
    expect(reportCalls).toHaveLength(1 + REPORT_RETRIES);
    expect(deps.sleeps).toEqual([500, 1000, 2000]);
    expect(deps.errLines.at(-1)).toContain('failed after 3 retries');
    expect(deps.errLines.at(-1)).toContain('stays in its server-side state');
  });

  it('retries a failing claim the same way, then reports the cycle as failed', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        deps.fetchCalls.push({ url: String(url), init: init as RequestInit });
        throw new TypeError('connection refused');
      }) as typeof fetch,
    });
    const result = await runOnce(OPTIONS, deps);

    expect(result).toEqual({ outcome: 'failed' });
    expect(deps.fetchCalls).toHaveLength(1 + REPORT_RETRIES);
    expect(deps.spawned).toHaveLength(0);
    expect(deps.errLines.at(-1)).toContain('claim failed after 3 retries');
    expect(deps.errLines.at(-1)).toContain('cannot reach the Helm Agent server');
  });
});

describe('fatal classification (review P1)', () => {
  it('RunnerError defaults to non-fatal; the flag is opt-in', () => {
    expect(new RunnerError('boom').fatal).toBe(false);
    expect(new RunnerError('boom', { fatal: true }).fatal).toBe(true);
  });

  it('marks spawn-level failure fatal: the claimed task still reports its -1 run, then the cycle carries fatal', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        const call = { url: String(url), init: init as RequestInit };
        deps.fetchCalls.push(call);
        if (call.url.endsWith('/tasks/claim')) {
          return jsonResponse(taskBody());
        }
        return jsonResponse(taskBody({ status: 'dispatched' }));
      }) as typeof fetch,
      spawnAgent: async () => {
        throw new Error('spawn agent-run ENOENT');
      },
    });
    const result = await runOnce(OPTIONS, deps);

    // The fabricated -1 run IS reported so the row carries the reason...
    expect(result).toEqual({
      outcome: 'claimed',
      taskId: 'T-0042',
      exitCode: -1,
      fatal: 'spawn',
    });
    const body = JSON.parse(String(deps.fetchCalls.at(-1)!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ taskId: 'T-0042', exitCode: -1 });
    expect(String(body.logTail)).toContain('runner error: spawn agent-run ENOENT');
    expect(deps.errLines.at(-1)).toContain('fatal: the agent command template failed to spawn');
  });

  it('never retries a spawn failure', async () => {
    let spawnAttempts = 0;
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        const call = { url: String(url), init: init as RequestInit };
        deps.fetchCalls.push(call);
        if (call.url.endsWith('/tasks/claim')) {
          return jsonResponse(taskBody());
        }
        return jsonResponse(taskBody());
      }) as typeof fetch,
      spawnAgent: async () => {
        spawnAttempts += 1;
        throw new Error('spawn ENOENT');
      },
    });
    await runOnce(OPTIONS, deps);
    expect(spawnAttempts).toBe(1); // spawn is not inside the retry policy
  });

  it('marks a claim 401 fatal and skips the retry policy entirely', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        deps.fetchCalls.push({ url: String(url), init: init as RequestInit });
        return new Response(null, { status: 401 });
      }) as typeof fetch,
    });
    const result = await runOnce(OPTIONS, deps);

    expect(result).toEqual({ outcome: 'failed', fatal: 'claim' });
    expect(deps.fetchCalls).toHaveLength(1); // 401 cannot heal: no retries
    expect(deps.sleeps).toEqual([]);
    expect(deps.errLines.at(-1)).toContain('claim failed (fatal)');
    expect(deps.errLines.at(-1)).toContain('rejected the API token');
  });

  it('marks an unparsable claim payload fatal (no retries)', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        deps.fetchCalls.push({ url: String(url), init: init as RequestInit });
        return jsonResponse({ nope: 'not a contract Task' });
      }) as typeof fetch,
    });
    const result = await runOnce(OPTIONS, deps);

    expect(result).toEqual({ outcome: 'failed', fatal: 'claim' });
    expect(deps.fetchCalls).toHaveLength(1);
    expect(deps.errLines.at(-1)).toContain('unexpected claim payload');
  });

  it('circuit-breaks the loop on a spawn fatal (one cycle, exit-code failure)', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        const call = { url: String(url), init: init as RequestInit };
        deps.fetchCalls.push(call);
        if (call.url.endsWith('/tasks/claim')) {
          return jsonResponse(taskBody());
        }
        return jsonResponse(taskBody());
      }) as typeof fetch,
      spawnAgent: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    const result = await runRunner(
      { ...OPTIONS, once: false, intervalSeconds: 1 },
      { ...deps, stopped: () => false }, // nothing asked it to stop
    );

    expect(result.ok).toBe(false);
    const claimCalls = deps.fetchCalls.filter((call) => call.url.endsWith('/tasks/claim'));
    expect(claimCalls).toHaveLength(1); // broke after the FIRST fatal cycle
    expect(deps.sleeps).toEqual([]); // no idle sleep before the break
    expect(deps.errLines.at(-1)).toContain('已熔断');
    expect(deps.errLines.at(-1)).toContain('--agent 模板');
  });

  it('circuit-breaks the loop on a claim fatal (one cycle, exit-code failure)', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        deps.fetchCalls.push({ url: String(url), init: init as RequestInit });
        return new Response(null, { status: 401 });
      }) as typeof fetch,
    });
    const result = await runRunner(
      { ...OPTIONS, once: false, intervalSeconds: 1 },
      { ...deps, stopped: () => false },
    );

    expect(result.ok).toBe(false);
    const claimCalls = deps.fetchCalls.filter((call) => call.url.endsWith('/tasks/claim'));
    expect(claimCalls).toHaveLength(1);
    expect(deps.errLines.at(-1)).toContain('已熔断');
  });

  it('keeps looping on NON-fatal claim failures (network errors stay decision 9)', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        deps.fetchCalls.push({ url: String(url), init: init as RequestInit });
        throw new TypeError('connection refused');
      }) as typeof fetch,
    });
    const failedCycles = () => Math.floor(deps.fetchCalls.length / (1 + REPORT_RETRIES));
    const result = await runRunner(
      { ...OPTIONS, once: false, intervalSeconds: 1 },
      { ...deps, stopped: () => failedCycles() >= 2 },
    );

    expect(result.ok).toBe(false);
    expect(failedCycles()).toBe(2); // two full retried cycles, no circuit break
  });
});

describe('runRunner', () => {
  it('requires an agent template', async () => {
    await expect(runRunner({ ...OPTIONS, agentTemplate: '' }, makeDeps())).rejects.toBeInstanceOf(
      RunnerError,
    );
  });

  it('runs exactly one cycle with --once even when tasks keep arriving', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        deps.fetchCalls.push({ url: String(url), init: init as RequestInit });
        return jsonResponse(taskBody());
      }) as typeof fetch,
    });
    const result = await runRunner(OPTIONS, deps);
    expect(result.ok).toBe(true);
    const claimCalls = deps.fetchCalls.filter((call) => call.url.endsWith('/tasks/claim'));
    expect(claimCalls).toHaveLength(1);
  });

  it('keeps looping until the stop flag is set, then exits after the current cycle', async () => {
    const deps = makeDeps({
      fetch: (async (url: unknown, init: unknown) => {
        const call = { url: String(url), init: init as RequestInit };
        deps.fetchCalls.push(call);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const claimedCycles = () =>
      deps.fetchCalls.filter((call) => call.url.endsWith('/tasks/claim')).length;
    const result = await runRunner(
      { ...OPTIONS, once: false, intervalSeconds: 1 },
      {
        ...deps,
        // Stop once the THIRD cycle has run: three cycles, then out.
        stopped: () => claimedCycles() >= 3,
      },
    );
    expect(result.ok).toBe(true);
    expect(claimedCycles()).toBe(3);
    expect(deps.sleeps).toEqual([1000, 1000]); // sleep happens BETWEEN cycles only
  });

  it('marks the run failed when its single --once cycle fails', async () => {
    const deps = makeDeps({
      fetch: (async () => {
        throw new TypeError('down');
      }) as typeof fetch,
    });
    const result = await runRunner(OPTIONS, deps);
    expect(result.ok).toBe(false);
  });

  it('wakes the idle sleep on a signal and exits after the current cycle', async () => {
    const listenersBefore = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    const runtime = createProcessRuntime();
    try {
      const pending = runtime.sleep(60_000);
      process.emit('SIGINT'); // simulate the operator pressing Ctrl+C
      await expect(pending).resolves.toBeUndefined();
      expect(runtime.stopped()).toBe(true);
      // `once` semantics: the emitted SIGINT listener has consumed itself
      // (a SECOND Ctrl+C takes Node's default hard exit); the SIGTERM one
      // is still attached until dispose().
      expect(process.listenerCount('SIGINT')).toBe(listenersBefore.sigint);
      expect(process.listenerCount('SIGTERM')).toBe(listenersBefore.sigterm + 1);
    } finally {
      runtime.dispose();
    }
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore.sigterm);
  });
});
