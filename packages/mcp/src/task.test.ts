import { describe, expect, it, vi } from 'vitest';
import type { Board, GapGroups, HelmApi, LinkageGap } from './client.js';
import { buildAdvisory, compareGaps } from './task.js';

const gap = (overrides: Partial<LinkageGap>): LinkageGap => ({
  id: 'gap_x',
  relationId: 'rel_1',
  signal: 'privacy_policy',
  checkType: 'text_drift',
  description: 'page links the old policy',
  impact: 'stale terms',
  evidence: [
    { projectId: 'prj_app', path: 'src/legal/privacy.md', changedAt: '2026-10-10T00:00:00.000Z' },
  ],
  rootChangeId: 'rc_1',
  severity: 'medium',
  status: 'open',
  detectedAt: '2026-10-10T00:00:00.000Z',
  ...overrides,
});

const board: Board = {
  generatedAt: '2026-10-12T00:00:00.000Z',
  projects: [
    {
      id: 'prj_app',
      name: 'Companion App',
      repo: 'acme/companion-app',
      goal: 'ship v2',
      stage: 'build',
      priority: 'high',
      snapshot: null,
      ci: {
        status: 'passing',
        branch: 'release/2.0',
        lastConclusion: null,
        lastRunTs: null,
        failingSince: null,
        consecutiveFailures: 0,
      },
      milestones: null,
      risks: [],
    },
  ],
};

const relation = {
  id: 'rel_1',
  sourceProjectId: 'prj_app',
  targetProjectId: 'prj_page',
  kind: 'app-to-product-page',
  rules: [],
  origin: 'manual',
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
};

function groupsOf(gaps: LinkageGap[]): GapGroups {
  return {
    groups: gaps.map((gapItem) => ({
      rootChangeId: gapItem.rootChangeId,
      severity: gapItem.severity,
      firstDetectedAt: gapItem.detectedAt,
      gaps: [gapItem],
    })),
    total: gaps.length,
  };
}

interface FakeOptions {
  relations?: (typeof relation)[];
  gaps?: LinkageGap[];
  board?: Board;
}

function makeFakeApi(options: FakeOptions = {}): HelmApi {
  return {
    fetchBoard: vi.fn().mockResolvedValue(options.board ?? board),
    fetchRelations: vi.fn().mockResolvedValue(options.relations ?? [relation]),
    fetchOpenGapGroups: vi.fn().mockResolvedValue(groupsOf(options.gaps ?? [])),
    fetchLatestBriefing: vi.fn().mockResolvedValue(null),
    reportProgress: vi.fn().mockResolvedValue({ received: true, audited: true }),
  };
}

describe('compareGaps (canonical order)', () => {
  it('orders by severity desc, then newest detection, then id for stability', () => {
    const high = gap({ id: 'high', severity: 'high', detectedAt: '2026-10-01T00:00:00.000Z' });
    const medium = gap({
      id: 'med-old',
      severity: 'medium',
      detectedAt: '2026-10-09T00:00:00.000Z',
    });
    const mediumNew = gap({
      id: 'med-new',
      severity: 'medium',
      detectedAt: '2026-10-11T00:00:00.000Z',
    });
    const tieA = gap({ id: 'tie-a', severity: 'low', detectedAt: '2026-10-05T00:00:00.000Z' });
    const tieB = gap({ id: 'tie-b', severity: 'low', detectedAt: '2026-10-05T00:00:00.000Z' });

    const sorted = [tieB, mediumNew, medium, high, tieA].sort(compareGaps);
    expect(sorted.map((item) => item.id)).toEqual(['high', 'med-new', 'med-old', 'tie-a', 'tie-b']);
  });
});

describe('buildAdvisory', () => {
  it('returns the flat advisory for the top-ranked gap', async () => {
    const api = makeFakeApi({
      gaps: [
        gap({ id: 'gap_low', severity: 'low', detectedAt: '2026-10-11T00:00:00.000Z' }),
        gap({
          id: 'gap_top',
          severity: 'high',
          detectedAt: '2026-10-09T00:00:00.000Z',
          signal: 'version_release',
          description: 'portal still announces v1.9',
          impact: 'users miss the release',
        }),
      ],
    });
    const advisory = await buildAdvisory(api);
    expect(advisory).toEqual({
      advisory: true,
      gapId: 'gap_top',
      signal: 'version_release',
      severity: 'high',
      description: 'portal still announces v1.9',
      impact: 'users miss the release',
      repo: 'acme/companion-app',
      path: 'src/legal/privacy.md',
      actionUrl: 'https://github.com/acme/companion-app/blob/release/2.0/src/legal/privacy.md',
    });
    expect('task' in advisory).toBe(false);
  });

  it('prefers the last board-resolvable evidence entry for the action link', async () => {
    const api = makeFakeApi({
      gaps: [
        gap({
          id: 'gap_top',
          severity: 'high',
          evidence: [
            {
              projectId: 'prj_unknown',
              path: 'docs/untracked.md',
              changedAt: '2026-10-10T00:00:00.000Z',
            },
            { projectId: 'prj_app', path: 'src/found.md', changedAt: '2026-10-10T01:00:00.000Z' },
          ],
        }),
      ],
    });
    const advisory = await buildAdvisory(api);
    expect(advisory).toMatchObject({ repo: 'acme/companion-app', path: 'src/found.md' });
  });

  it('falls back to the default branch main when the CI branch is unknown', async () => {
    const api = makeFakeApi({
      board: { ...board, projects: [{ ...board.projects[0]!, ci: null }] },
      gaps: [gap({ id: 'gap_top', severity: 'high' })],
    });
    const advisory = await buildAdvisory(api);
    expect(advisory).toMatchObject({
      actionUrl: 'https://github.com/acme/companion-app/blob/main/src/legal/privacy.md',
    });
  });

  it('leaves repo/path/actionUrl null when no evidence project is tracked', async () => {
    const api = makeFakeApi({
      gaps: [
        gap({
          id: 'gap_top',
          severity: 'high',
          evidence: [
            { projectId: 'prj_ghost', path: 'x.md', changedAt: '2026-10-10T00:00:00.000Z' },
          ],
        }),
      ],
    });
    const advisory = await buildAdvisory(api);
    expect(advisory).toEqual({
      advisory: true,
      gapId: 'gap_top',
      signal: 'privacy_policy',
      severity: 'high',
      description: 'page links the old policy',
      impact: 'stale terms',
      repo: null,
      path: null,
      actionUrl: null,
    });
  });

  it('returns the no-task advisory when every chain is in sync, without touching the board', async () => {
    const api = makeFakeApi({ gaps: [] });
    const advisory = await buildAdvisory(api);
    expect(advisory).toEqual({ advisory: true, task: null, note: 'all chains are in sync' });
    expect(api.fetchBoard).not.toHaveBeenCalled();
  });

  it('consults only active relations', async () => {
    const paused = { ...relation, id: 'rel_paused', status: 'paused' as const };
    const api = makeFakeApi({ relations: [relation, paused], gaps: [] });
    await buildAdvisory(api);
    expect(api.fetchOpenGapGroups).toHaveBeenCalledWith('rel_1');
    expect(api.fetchOpenGapGroups).not.toHaveBeenCalledWith('rel_paused');
  });
});
