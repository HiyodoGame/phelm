import { describe, expect, it } from 'vitest';
import {
  AgentTypeSchema,
  DateOnlySchema,
  EffortSchema,
  KNOWN_AGENTS,
  PrioritySchema,
  RepoRefSchema,
  StageSchema,
  TaskIdSchema,
  TimestampSchema,
} from './primitives.js';

describe('TimestampSchema', () => {
  it('accepts ISO 8601 datetime strings', () => {
    expect(TimestampSchema.parse('2026-10-09T08:30:00Z')).toBe('2026-10-09T08:30:00Z');
  });

  it('rejects non-datetime strings', () => {
    expect(TimestampSchema.safeParse('2026-10-09').success).toBe(false);
    expect(TimestampSchema.safeParse('yesterday').success).toBe(false);
  });

  it('rejects offset datetimes (UTC "Z" form only)', () => {
    // Locks the current zod default; if a zod upgrade ever widens this,
    // this test forces a conscious decision.
    expect(TimestampSchema.safeParse('2026-10-09T08:30:00+08:00').success).toBe(false);
  });
});

describe('DateOnlySchema', () => {
  it('accepts ISO calendar dates', () => {
    expect(DateOnlySchema.parse('2026-10-09')).toBe('2026-10-09');
  });

  it('rejects datetime strings and malformed dates', () => {
    expect(DateOnlySchema.safeParse('2026-10-09T00:00:00Z').success).toBe(false);
    expect(DateOnlySchema.safeParse('2026-13-01').success).toBe(false);
  });
});

describe('EffortSchema', () => {
  it('accepts S, M, and L', () => {
    for (const effort of ['S', 'M', 'L']) {
      expect(EffortSchema.parse(effort)).toBe(effort);
    }
  });

  it('rejects unknown effort values', () => {
    expect(EffortSchema.safeParse('XL').success).toBe(false);
    expect(EffortSchema.safeParse('s').success).toBe(false);
  });
});

describe('PrioritySchema', () => {
  it('accepts P0 through P3', () => {
    for (const priority of ['P0', 'P1', 'P2', 'P3']) {
      expect(PrioritySchema.parse(priority)).toBe(priority);
    }
  });

  it('rejects unknown priorities', () => {
    expect(PrioritySchema.safeParse('P4').success).toBe(false);
  });
});

describe('StageSchema', () => {
  it('accepts every lifecycle stage', () => {
    for (const stage of ['exploring', 'developing', 'testing', 'released', 'maintaining']) {
      expect(StageSchema.parse(stage)).toBe(stage);
    }
  });

  it('rejects unknown stages', () => {
    expect(StageSchema.safeParse('archived').success).toBe(false);
  });
});

describe('AgentTypeSchema', () => {
  it('accepts every known agent and arbitrary non-empty identifiers', () => {
    for (const agent of KNOWN_AGENTS) {
      expect(AgentTypeSchema.parse(agent)).toBe(agent);
    }
    expect(AgentTypeSchema.safeParse('some-future-agent').success).toBe(true);
  });

  it('rejects empty identifiers', () => {
    expect(AgentTypeSchema.safeParse('').success).toBe(false);
  });

  it('lists the first-party integrations without duplicates', () => {
    expect(KNOWN_AGENTS).toEqual([
      'cursor',
      'claude-code',
      'kimi-code',
      'zcode',
      'opencode',
      'deveco-code',
      'copilot',
    ]);
  });
});

describe('RepoRefSchema', () => {
  it('accepts owner/name references', () => {
    for (const ref of ['HiyodoGame/phelm', 'a-b/e.f-g', 'o0/name_1', 'a/name']) {
      expect(RepoRefSchema.parse(ref)).toBe(ref);
    }
  });

  it('rejects malformed references', () => {
    const invalid = [
      '',
      'owner',
      'owner/',
      '/name',
      '-owner/name',
      'owner-/name',
      'a--b/name',
      'owner name',
      'owner/name/extra',
    ];
    for (const ref of invalid) {
      expect(RepoRefSchema.safeParse(ref).success).toBe(false);
    }
  });
});

describe('TaskIdSchema', () => {
  it('accepts well-formed task ids', () => {
    expect(TaskIdSchema.parse('T-0001')).toBe('T-0001');
    expect(TaskIdSchema.parse('T-1234')).toBe('T-1234');
  });

  it('rejects malformed task ids', () => {
    const invalid = ['', 'T-001', 'T-12345', 't-0001', 'T-00ab', 'T-0001 ', 'TASK-0001'];
    for (const value of invalid) {
      expect(TaskIdSchema.safeParse(value).success).toBe(false);
    }
  });
});
