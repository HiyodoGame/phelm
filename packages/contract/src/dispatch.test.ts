import { describe, expect, it } from 'vitest';
import { AgentConnectionSchema, TaskSchema, TaskSpecSchema, defaultBranchFor } from './dispatch.js';

const spec = {
  taskId: 'T-0042',
  project: 'proj-1',
  repo: 'HiyodoGame/phelm',
  goal: 'Implement the JSON Schema export script',
  context: {
    issues: ['https://github.com/HiyodoGame/phelm/issues/7'],
    files: ['packages/contract/scripts/export-json-schema.ts'],
    constraints: ['no new runtime dependencies'],
  },
  acceptance: ['pnpm schema:export writes dist/schemas/*.json'],
  targetAgent: 'zcode',
  limits: { maxDurationMinutes: 30 },
};

describe('TaskSpecSchema', () => {
  it('parses a valid spec and applies the safety defaults to limits', () => {
    const parsed = TaskSpecSchema.parse(spec);
    expect(parsed.branch).toBeUndefined();
    expect(parsed.limits.maxDurationMinutes).toBe(30);
    expect(parsed.limits.noDirectPushToMain).toBe(true);
    expect(parsed.limits.requirePr).toBe(true);
  });

  it('accepts an explicit branch', () => {
    const parsed = TaskSpecSchema.parse({ ...spec, branch: 'helm/T-0042-ci' });
    expect(parsed.branch).toBe('helm/T-0042-ci');
  });

  it('rejects malformed task ids and repos', () => {
    expect(TaskSpecSchema.safeParse({ ...spec, taskId: 'T-42' }).success).toBe(false);
    expect(TaskSpecSchema.safeParse({ ...spec, repo: 'phelm' }).success).toBe(false);
  });

  it('rejects empty goals and missing limits, while allowing empty context arrays', () => {
    expect(TaskSpecSchema.safeParse({ ...spec, acceptance: [] }).success).toBe(true);
    expect(TaskSpecSchema.safeParse({ ...spec, goal: '' }).success).toBe(false);
    expect(TaskSpecSchema.safeParse({ ...spec, limits: undefined }).success).toBe(false);
  });
});

describe('defaultBranchFor', () => {
  it('derives the helm/<taskId> convention', () => {
    expect(defaultBranchFor('T-0042')).toBe('helm/T-0042');
    expect(TaskSpecSchema.parse({ ...spec, branch: defaultBranchFor(spec.taskId) }).branch).toBe(
      'helm/T-0042',
    );
  });
});

const task = {
  id: 'task-42',
  projectId: 'proj-1',
  spec,
  targetAgent: 'zcode',
  channel: 'cli_runner',
  status: 'pr_opened',
  prUrl: 'https://github.com/HiyodoGame/phelm/pull/12',
  result: { prNumber: 12 },
};

describe('TaskSchema', () => {
  it('parses a valid task with an open PR', () => {
    const parsed = TaskSchema.parse(task);
    expect(parsed.prUrl).toBe('https://github.com/HiyodoGame/phelm/pull/12');
  });

  it('parses tasks without a prUrl or result', () => {
    const { prUrl: _prUrl, result: _result, ...minimal } = task;
    const parsed = TaskSchema.parse(minimal);
    expect(parsed.prUrl).toBeUndefined();
    expect(parsed.result).toBeUndefined();
  });

  it('rejects unknown channels and statuses, and malformed pr urls', () => {
    expect(TaskSchema.safeParse({ ...task, channel: 'smtp' }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...task, status: 'cancelled' }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...task, prUrl: 'not a url' }).success).toBe(false);
  });
});

const connection = {
  id: 'conn-1',
  userId: 'user-1',
  agentType: 'zcode',
  channel: 'mcp',
  credentialsRef: 'kms://agents/zcode/user-1',
  status: 'connected',
};

describe('AgentConnectionSchema', () => {
  it('parses a valid connection', () => {
    const parsed = AgentConnectionSchema.parse(connection);
    expect(parsed.status).toBe('connected');
  });

  it('rejects unknown statuses and empty credential refs', () => {
    expect(AgentConnectionSchema.safeParse({ ...connection, status: 'retired' }).success).toBe(
      false,
    );
    expect(AgentConnectionSchema.safeParse({ ...connection, credentialsRef: '' }).success).toBe(
      false,
    );
  });
});
