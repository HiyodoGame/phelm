import { describe, expect, it } from 'vitest';
import { EventSchema, HEALTH_FACTOR_KEYS, SnapshotSchema } from './events.js';

const event = {
  id: 'evt-1',
  projectId: 'proj-1',
  type: 'commit',
  actor: 'hiyodo',
  agent: 'zcode',
  payload: { sha: 'abc123', additions: 42, note: null },
  ts: '2026-10-09T08:30:00Z',
};

describe('EventSchema', () => {
  it('parses a valid agent-driven event with a loose payload', () => {
    const parsed = EventSchema.parse(event);
    expect(parsed.payload).toEqual({ sha: 'abc123', additions: 42, note: null });
  });

  it('parses events without an agent field', () => {
    const { agent: _agent, ...withoutAgent } = event;
    expect(EventSchema.parse(withoutAgent).agent).toBeUndefined();
  });

  it('rejects unknown event types', () => {
    expect(EventSchema.safeParse({ ...event, type: 'comment' }).success).toBe(false);
    expect(EventSchema.safeParse({ ...event, type: 'PR' }).success).toBe(false);
  });
});

const snapshot = {
  projectId: 'proj-1',
  date: '2026-10-09',
  healthScore: 72,
  factors: {
    milestone_progress: 40,
    activity: 85,
    ci_health: 90,
    direction_alignment: 70,
    open_blockers: 25,
  },
  summary: 'CI is green; milestone M1 is behind plan.',
};

describe('SnapshotSchema', () => {
  it('parses a valid snapshot carrying every health factor', () => {
    const parsed = SnapshotSchema.parse(snapshot);
    expect(Object.keys(parsed.factors).sort()).toEqual([...HEALTH_FACTOR_KEYS].sort());
  });

  it('rejects snapshots with missing, extra, or non-numeric factors', () => {
    const { activity: _activity, ...missing } = snapshot.factors;
    expect(SnapshotSchema.safeParse({ ...snapshot, factors: missing }).success).toBe(false);

    expect(
      SnapshotSchema.safeParse({ ...snapshot, factors: { ...snapshot.factors, extra: 1 } }).success,
    ).toBe(false);

    expect(
      SnapshotSchema.safeParse({ ...snapshot, factors: { ...snapshot.factors, activity: 'high' } })
        .success,
    ).toBe(false);
  });

  it('rejects health scores outside 0-100', () => {
    expect(SnapshotSchema.safeParse({ ...snapshot, healthScore: 101 }).success).toBe(false);
    expect(SnapshotSchema.safeParse({ ...snapshot, healthScore: -1 }).success).toBe(false);
  });
});
