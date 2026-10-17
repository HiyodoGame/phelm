import { describe, expect, it } from 'vitest';
import { BoardError, ciColor, fetchBoard, healthColor, progressBar, renderBoard } from './board.js';
import type { Board } from './board.js';

/** Offline board tests: scripted fetch + pure rendering assertions. */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SAMPLE: Board = {
  generatedAt: '2026-10-12T00:00:00.000Z',
  projects: [
    {
      id: 'prj_1',
      name: 'Helm Agent',
      repo: 'octo/helm-agent',
      goal: 'Ship the MVP',
      stage: 'developing',
      priority: 'P1',
      snapshot: {
        date: '2026-10-12',
        healthScore: 72,
        factors: {},
        summary: 'active; last CI failure',
      },
      ci: {
        status: 'failing',
        branch: 'main',
        lastConclusion: 'failure',
        lastRunTs: '2026-10-11T03:00:00.000Z',
        failingSince: '2026-10-10T03:00:00.000Z',
        consecutiveFailures: 2,
      },
      milestones: { count: 2, averageProgress: 60, nearestDueDate: '2026-11-01' },
      risks: [{ type: 'ci_failure', level: 'high', impact: 'red CI blocks merges' }],
    },
    {
      id: 'prj_2',
      name: 'Idle',
      repo: 'octo/idle',
      goal: 'Resting',
      stage: 'maintaining',
      priority: 'P3',
      snapshot: null,
      ci: null,
      milestones: null,
      risks: [],
    },
  ],
};

describe('healthColor / ciColor / progressBar', () => {
  it('buckets health scores into documented thresholds', () => {
    expect([100, 80, 79, 50, 49, 10, undefined].map(healthColor)).toEqual([
      'green',
      'green',
      'yellow',
      'yellow',
      'red',
      'red',
      'gray',
    ]);
  });

  it('maps CI states and renders a 10-cell bar', () => {
    expect([
      ciColor('passing'),
      ciColor('failing'),
      ciColor('unknown'),
      ciColor(undefined),
    ]).toEqual(['green', 'red', 'gray', 'gray']);
    expect(progressBar(60)).toBe('██████░░░░');
    expect(progressBar(0)).toBe('░░░░░░░░░░');
    expect(progressBar(100)).toBe('██████████');
    expect(progressBar(150)).toBe('██████████');
  });
});

describe('fetchBoard', () => {
  const base = { apiBaseUrl: 'http://localhost:3000/', token: 'tok' };

  it('fetches and validates the board payload', async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = (input) => {
      calls.push(String(input));
      return Promise.resolve(jsonResponse(SAMPLE));
    };
    const board = await fetchBoard({ ...base, fetch: fetchFn });
    expect(board.projects).toHaveLength(2);
    expect(calls[0]).toBe('http://localhost:3000/board');
  });

  it('accepts a null factor value instead of failing the whole board (T-0017)', async () => {
    // The producer reports an absent signal as `null`. Rejecting it would make
    // `phelm board` fail for EVERY project because one factor was honestly
    // reported as unknown — the failure mode this assertion exists to prevent.
    const payload = {
      ...SAMPLE,
      projects: [
        {
          ...SAMPLE.projects[0]!,
          snapshot: {
            ...SAMPLE.projects[0]!.snapshot!,
            factors: { activity: 3, direction_alignment: null },
          },
        },
        SAMPLE.projects[1]!,
      ],
    };
    const fetchFn: typeof fetch = () => Promise.resolve(jsonResponse(payload));
    const board = await fetchBoard({ ...base, fetch: fetchFn });
    expect(board.projects[0]?.snapshot?.factors.direction_alignment).toBeNull();
    expect(board.projects[0]?.snapshot?.factors.activity).toBe(3);
  });

  it('maps 401 / 503 / unreachable to user-actionable errors', async () => {
    await expect(
      fetchBoard({ ...base, fetch: () => Promise.resolve(jsonResponse({}, 401)) }),
    ).rejects.toThrow(/rejected the API token/);
    await expect(
      fetchBoard({ ...base, fetch: () => Promise.resolve(jsonResponse({}, 503)) }),
    ).rejects.toThrow(/disabled/);
    await expect(
      fetchBoard({ ...base, fetch: () => Promise.reject(new TypeError('down')) }),
    ).rejects.toThrow(/cannot reach/);
  });

  it('rejects unexpected payloads', async () => {
    await expect(
      fetchBoard({ ...base, fetch: () => Promise.resolve(jsonResponse({ nope: 1 })) }),
    ).rejects.toThrow(BoardError);
  });
});

describe('renderBoard', () => {
  it('renders health dots, CI red-since, milestone bar and risks', () => {
    const out = renderBoard(SAMPLE, { colors: false });

    expect(out).toContain('●  72  ●  Helm Agent  (octo/helm-agent)');
    expect(out).toContain('██████░░░░ 60% (2 ms)');
    expect(out).toContain('CI red since 2026-10-10 03:00 (2 in a row)');
    expect(out).toContain('risk [high] ci_failure: red CI blocks merges');
    expect(out).toContain('active; last CI failure');
  });

  it('renders the idle project with gray placeholders', () => {
    const out = renderBoard(SAMPLE, { colors: false });
    expect(out).toContain('● -  ●  Idle  (octo/idle)');
    expect(out).toContain('no milestones');
    expect(out).toContain('no snapshot yet');
  });

  it('hints importing when nothing is tracked', () => {
    const out = renderBoard({ generatedAt: 'x', projects: [] }, { colors: false });
    expect(out).toContain('phelm repos import');
  });

  it('adds ANSI codes only when colors are enabled', () => {
    const plain = renderBoard(SAMPLE, { colors: false });
    expect(plain).not.toContain('\x1b[');
    const colored = renderBoard(SAMPLE, { colors: true });
    expect(colored).toContain('\x1b[33m');
  });
});
