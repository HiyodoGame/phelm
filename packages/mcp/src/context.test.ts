import { describe, expect, it, vi } from 'vitest';
import type { Board, GapGroups, HelmApi } from './client.js';
import { buildProjectContext } from './context.js';
import type { ProjectRelation } from '@phelm/contract';

/** ---------- fixtures (kept per-file; see client.test.ts for the real client) ---------- */

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
      snapshot: { date: '2026-10-12', healthScore: 72, factors: { ci: -10 }, summary: 'CI red' },
      ci: {
        status: 'failing',
        branch: 'main',
        lastConclusion: 'failure',
        lastRunTs: '2026-10-11T10:00:00.000Z',
        failingSince: '2026-10-11T10:00:00.000Z',
        consecutiveFailures: 2,
      },
      milestones: { count: 2, averageProgress: 40, nearestDueDate: '2026-11-01' },
      risks: [{ type: 'red_ci', level: 'high', impact: 'blocked release' }],
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

const relation = {
  id: 'rel_1',
  sourceProjectId: 'prj_app',
  targetProjectId: 'prj_page',
  kind: 'app-to-product-page',
  rules: [{ signal: 'privacy_policy', enabled: true }],
  origin: 'manual',
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
} satisfies ProjectRelation;

const gapGroups: GapGroups = {
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

const briefing = {
  date: '2026-10-12',
  stats: {
    totalGaps: 1,
    relations: 1,
    maxSeverity: 'high' as const,
    chains: 1,
    pendingDrafts: 0,
    draftRelations: 0,
  },
  contentMd: '# briefing',
};

interface FakeOptions {
  briefing?: typeof briefing | null;
  relations?: ProjectRelation[];
}

function makeFakeApi(options: FakeOptions = {}): HelmApi & {
  gapCalls: string[];
} {
  const gapCalls: string[] = [];
  return {
    gapCalls,
    fetchBoard: vi.fn().mockResolvedValue(board),
    fetchRelations: vi.fn().mockResolvedValue(options.relations ?? [relation]),
    fetchOpenGapGroups: vi.fn().mockImplementation((relationId: string) => {
      gapCalls.push(relationId);
      return Promise.resolve(gapGroups);
    }),
    fetchLatestBriefing:
      options.briefing === null
        ? vi.fn().mockResolvedValue(null)
        : vi.fn().mockResolvedValue(options.briefing ?? briefing),
  };
}

/** ---------- behavior ---------- */

describe('buildProjectContext', () => {
  it('assembles board + active relations + open gap summaries for all projects', async () => {
    const api = makeFakeApi();
    const context = await buildProjectContext(api);

    expect(context.tracked).toBe(true);
    if (!context.tracked) {
      return;
    }
    expect(context.generatedAt).toBe('2026-10-12T00:00:00.000Z');
    expect(context.projects).toHaveLength(2);

    const app = context.projects[0]!;
    expect(app.snapshot?.healthScore).toBe(72);
    expect(app.ci?.status).toBe('failing');
    expect(app.milestones?.count).toBe(2);
    expect(app.risks).toHaveLength(1);
    expect(app.relations).toEqual([
      {
        id: 'rel_1',
        kind: 'app-to-product-page',
        direction: 'source',
        counterpartyProjectId: 'prj_page',
        counterpartyName: 'Product Page',
        counterpartyRepo: 'acme/product-page',
        openGaps: [{ id: 'gap_1', severity: 'high', description: 'page links the old policy' }],
      },
    ]);

    const page = context.projects[1]!;
    expect(page.relations[0]?.direction).toBe('target');
    expect(page.relations[0]?.counterpartyRepo).toBe('acme/companion-app');

    expect(context.latestBriefing).toEqual(briefing);
  });

  it('fetches each relation\u2019s gaps once even in the all-projects view', async () => {
    const api = makeFakeApi();
    await buildProjectContext(api);
    expect(api.gapCalls).toEqual(['rel_1']);
  });

  it('scopes to one repo and keeps the counterparty lookup', async () => {
    const api = makeFakeApi();
    const context = await buildProjectContext(api, { repo: 'acme/product-page' });
    expect(context.tracked).toBe(true);
    if (!context.tracked) {
      return;
    }
    expect(context.projects.map((project) => project.repo)).toEqual(['acme/product-page']);
    expect(context.projects[0]?.relations[0]?.direction).toBe('target');
  });

  it('answers an untracked repo with the explicit not-tracked result and reads nothing else', async () => {
    const api = makeFakeApi();
    const context = await buildProjectContext(api, { repo: 'acme/ghost' });
    expect(context).toEqual({
      tracked: false,
      repo: 'acme/ghost',
      message: 'project not tracked: no board project has repo "acme/ghost"',
    });
    expect(api.fetchRelations).not.toHaveBeenCalled();
    expect(api.fetchOpenGapGroups).not.toHaveBeenCalled();
    expect(api.fetchLatestBriefing).not.toHaveBeenCalled();
  });

  it('omits latestBriefing when no briefing has been generated yet', async () => {
    const api = makeFakeApi({ briefing: null });
    const context = await buildProjectContext(api);
    expect(context.tracked).toBe(true);
    if (!context.tracked) {
      return;
    }
    expect('latestBriefing' in context).toBe(false);
  });

  it('marks the counterparty untracked when it is not on the board', async () => {
    const api = makeFakeApi({
      relations: [{ ...relation, targetProjectId: 'prj_ghost' }],
    });
    const context = await buildProjectContext(api, { repo: 'acme/companion-app' });
    expect(context.tracked).toBe(true);
    if (!context.tracked) {
      return;
    }
    expect(context.projects[0]?.relations[0]?.counterpartyName).toBeNull();
    expect(context.projects[0]?.relations[0]?.counterpartyRepo).toBeNull();
  });
});
