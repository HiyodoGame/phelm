import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProjectCharterSchema, MilestoneSchema } from './charter.js';
import { AgentConnectionSchema, TaskSchema, TaskSpecSchema } from './dispatch.js';
import { EventSchema, SnapshotSchema } from './events.js';
import { UserSchema, DecisionLogSchema } from './identity.js';
import { ProposalSchema, RiskSchema, SuggestionSchema } from './judgment.js';

/**
 * Every entity object is strict: unknown keys are rejected (not silently
 * stripped), matching the exported JSON Schemas' additionalProperties:false.
 * This suite locks that policy in one place for all 11 entities + TaskSpec.
 */
const taskSpec = {
  taskId: 'T-0001',
  project: 'prj_1',
  repo: 'HiyodoGame/phelm',
  goal: 'ship it',
  context: { issues: [], files: [], constraints: [] },
  acceptance: ['CI green'],
  targetAgent: 'zcode',
  limits: { noDirectPushToMain: true, requirePr: true },
} satisfies z.input<typeof TaskSpecSchema>;

const cases = [
  [
    'User',
    UserSchema,
    { id: 'u1', githubLogin: 'octocat', settings: { notificationLevel: 'all' } },
  ],
  [
    'ProjectCharter',
    ProjectCharterSchema,
    {
      id: 'prj_1',
      repo: 'HiyodoGame/phelm',
      name: 'phelm',
      goal: 'manage agents',
      stage: 'developing',
      priority: 'P1',
      cadence: 3,
      constraints: [],
      agents: [],
    },
  ],
  [
    'Milestone',
    MilestoneSchema,
    {
      id: 'ms_1',
      projectId: 'prj_1',
      title: 'P0 done',
      dueDate: '2026-11-30',
      acceptance: [],
      progress: 0,
      source: 'manual',
    },
  ],
  [
    'Event',
    EventSchema,
    {
      id: 'evt_1',
      projectId: 'prj_1',
      type: 'commit',
      actor: 'octocat',
      payload: {},
      ts: '2026-10-10T08:00:00Z',
    },
  ],
  [
    'Snapshot',
    SnapshotSchema,
    {
      projectId: 'prj_1',
      date: '2026-10-10',
      healthScore: 80,
      factors: {
        milestone_progress: 1,
        activity: 2,
        ci_health: 3,
        direction_alignment: 4,
        open_blockers: 5,
      },
      summary: 'on track',
    },
  ],
  [
    'Risk',
    RiskSchema,
    {
      id: 'rsk_1',
      projectId: 'prj_1',
      type: 'stagnation',
      level: 'low',
      evidence: ['https://github.com/x/y/pull/1'],
      impact: 'slows the milestone',
      status: 'open',
      feedback: null,
    },
  ],
  [
    'Suggestion',
    SuggestionSchema,
    {
      id: 'sug_1',
      projectId: 'prj_1',
      content: 'fix the CI',
      reason: 'blocks release',
      effort: 'S',
      rank: 1,
      status: 'shown',
    },
  ],
  [
    'Proposal',
    ProposalSchema,
    {
      id: 'prp_1',
      projectId: 'prj_1',
      type: 'adjust_priority',
      before: {},
      after: {},
      impact: 'reorders the week',
      level: 'L1',
      status: 'draft',
    },
  ],
  ['TaskSpec', TaskSpecSchema, taskSpec],
  [
    'Task',
    TaskSchema,
    {
      id: 'tsk_1',
      projectId: 'prj_1',
      spec: taskSpec,
      targetAgent: 'zcode',
      channel: 'mcp',
      status: 'created',
    },
  ],
  [
    'AgentConnection',
    AgentConnectionSchema,
    {
      id: 'ac_1',
      userId: 'u1',
      agentType: 'cursor',
      channel: 'mcp',
      credentialsRef: 'kms://ac_1',
      status: 'connected',
    },
  ],
  [
    'DecisionLog',
    DecisionLogSchema,
    {
      id: 'dl_1',
      actor: 'user',
      actorRef: 'u1',
      action: 'suggestion.dismissed',
      ref: 'sug_1',
      ts: '2026-10-10T08:00:00Z',
    },
  ],
] as const;

describe('strict entity shapes', () => {
  for (const [name, schema, sample] of cases) {
    it(`${name}: accepts a valid sample`, () => {
      expect(schema.parse(sample)).toBeTruthy();
    });

    it(`${name}: rejects unknown top-level keys`, () => {
      expect(schema.safeParse({ ...sample, __unknown: 1 }).success).toBe(false);
    });
  }

  it('rejects unknown keys in nested objects (settings, context, limits)', () => {
    expect(
      UserSchema.safeParse({
        id: 'u1',
        githubLogin: 'octocat',
        settings: { notificationLevel: 'all', __unknown: 1 },
      }).success,
    ).toBe(false);
    expect(
      TaskSpecSchema.safeParse({
        ...taskSpec,
        context: { issues: [], files: [], constraints: [], __unknown: 1 },
      }).success,
    ).toBe(false);
    expect(
      TaskSpecSchema.safeParse({
        ...taskSpec,
        limits: { noDirectPushToMain: true, requirePr: true, __unknown: 1 },
      }).success,
    ).toBe(false);
  });
});
