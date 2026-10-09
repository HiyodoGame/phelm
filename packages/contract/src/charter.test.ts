import { describe, expect, it } from 'vitest';
import { MilestoneSchema, ProjectCharterSchema } from './charter.js';

const charter = {
  id: 'proj-1',
  repo: 'HiyodoGame/phelm',
  name: 'phelm',
  goal: 'Ship the MVP task board tracker',
  stage: 'developing',
  priority: 'P1',
  cadence: 3,
  constraints: ['no direct pushes to main', 'all changes go through PRs'],
  agents: ['zcode', 'claude-code'],
};

describe('ProjectCharterSchema', () => {
  it('parses a valid charter', () => {
    const parsed = ProjectCharterSchema.parse(charter);
    expect(parsed.id).toBe('proj-1');
    expect(parsed.agents).toEqual(['zcode', 'claude-code']);
  });

  it('rejects unknown stages and priorities', () => {
    expect(ProjectCharterSchema.safeParse({ ...charter, stage: 'archived' }).success).toBe(false);
    expect(ProjectCharterSchema.safeParse({ ...charter, priority: 'P9' }).success).toBe(false);
  });

  it('rejects malformed repos and non-positive cadence', () => {
    expect(ProjectCharterSchema.safeParse({ ...charter, repo: 'phelm' }).success).toBe(false);
    expect(ProjectCharterSchema.safeParse({ ...charter, cadence: 0 }).success).toBe(false);
    expect(ProjectCharterSchema.safeParse({ ...charter, cadence: 1.5 }).success).toBe(false);
  });
});

const milestone = {
  id: 'ms-1',
  projectId: 'proj-1',
  title: 'M1: contract schemas',
  dueDate: '2026-10-31',
  acceptance: ['all 11 entities exported', 'json schemas published'],
  progress: 40,
  source: 'manual',
};

describe('MilestoneSchema', () => {
  it('parses a valid milestone', () => {
    const parsed = MilestoneSchema.parse(milestone);
    expect(parsed.progress).toBe(40);
  });

  it('rejects progress outside 0-100 and non-integer values', () => {
    expect(MilestoneSchema.safeParse({ ...milestone, progress: -1 }).success).toBe(false);
    expect(MilestoneSchema.safeParse({ ...milestone, progress: 101 }).success).toBe(false);
    expect(MilestoneSchema.safeParse({ ...milestone, progress: 40.5 }).success).toBe(false);
  });

  it('rejects unknown sources and datetime due dates', () => {
    expect(MilestoneSchema.safeParse({ ...milestone, source: 'jira' }).success).toBe(false);
    expect(
      MilestoneSchema.safeParse({ ...milestone, dueDate: '2026-10-31T00:00:00Z' }).success,
    ).toBe(false);
  });
});
