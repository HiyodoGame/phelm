import { describe, expect, it } from 'vitest';
import { LinkageGapSchema, ProjectRelationSchema } from './relation.js';

const relation = {
  id: 'rel_1',
  sourceProjectId: 'prj_1',
  targetProjectId: 'prj_2',
  kind: 'app-to-product-page',
  sourceRole: 'app',
  targetRole: 'product-page',
  rules: [{ signal: 'version_release', enabled: true }],
  origin: 'inferred',
  inferredFrom: ['issue_42'],
  status: 'draft',
  createdAt: '2026-10-10T08:00:00Z',
};

const gap = {
  id: 'gap_1',
  relationId: 'rel_1',
  signal: 'version_release',
  description: 'the portal entry still links to v2.2',
  impact: 'users reach an outdated release page',
  evidence: [{ projectId: 'prj_2', path: 'docs/entry.md', changedAt: '2026-10-10T08:00:00Z' }],
  rootChangeId: 'chg_1',
  detectedAt: '2026-10-10T09:30:00Z',
  severity: 'medium',
  status: 'open',
};

describe('ProjectRelationSchema', () => {
  it('roundtrips a valid relation', () => {
    expect(ProjectRelationSchema.parse(relation)).toEqual(relation);
  });

  it('rejects unknown top-level and nested keys', () => {
    expect(ProjectRelationSchema.safeParse({ ...relation, __unknown: 1 }).success).toBe(false);
    expect(
      ProjectRelationSchema.safeParse({
        ...relation,
        rules: [{ signal: 'version_release', enabled: true, __unknown: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejects invalid kinds and signals', () => {
    expect(ProjectRelationSchema.safeParse({ ...relation, kind: 'app-to-site' }).success).toBe(
      false,
    );
    expect(
      ProjectRelationSchema.safeParse({
        ...relation,
        rules: [{ signal: 'changelog', enabled: true }],
      }).success,
    ).toBe(false);
  });

  it('accepts an empty rules array (a relation can be created before its rules are configured)', () => {
    expect(ProjectRelationSchema.safeParse({ ...relation, rules: [] }).success).toBe(true);
  });

  it('rejects malformed timestamps and empty ids', () => {
    expect(ProjectRelationSchema.safeParse({ ...relation, createdAt: '2026-10-10' }).success).toBe(
      false,
    );
    expect(ProjectRelationSchema.safeParse({ ...relation, sourceProjectId: '' }).success).toBe(
      false,
    );
  });
});

describe('LinkageGapSchema', () => {
  it('roundtrips a valid gap, with and without causedByGapId', () => {
    expect(LinkageGapSchema.parse(gap)).toEqual(gap);
    expect(LinkageGapSchema.parse(gap).detectedAt).toBe('2026-10-10T09:30:00Z');
    const transitive = { ...gap, causedByGapId: 'gap_0' };
    expect(LinkageGapSchema.parse(transitive)).toEqual(transitive);
  });

  it('rejects a gap without or with a malformed detectedAt (detection time is mandatory)', () => {
    expect(LinkageGapSchema.safeParse({ ...gap, detectedAt: undefined }).success).toBe(false);
    expect(LinkageGapSchema.safeParse({ ...gap, detectedAt: '2026-10-10' }).success).toBe(false);
  });

  it('rejects unknown top-level and nested keys', () => {
    expect(LinkageGapSchema.safeParse({ ...gap, __unknown: 1 }).success).toBe(false);
    expect(
      LinkageGapSchema.safeParse({
        ...gap,
        evidence: [{ ...gap.evidence[0], __unknown: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty evidence array (no evidence, no gap)', () => {
    expect(LinkageGapSchema.safeParse({ ...gap, evidence: [] }).success).toBe(false);
    expect(LinkageGapSchema.safeParse({ ...gap, evidence: undefined }).success).toBe(false);
  });

  it('rejects invalid signals', () => {
    expect(LinkageGapSchema.safeParse({ ...gap, signal: 'changelog' }).success).toBe(false);
  });

  it('rejects empty descriptions and impacts', () => {
    expect(LinkageGapSchema.safeParse({ ...gap, description: '' }).success).toBe(false);
    expect(LinkageGapSchema.safeParse({ ...gap, impact: '' }).success).toBe(false);
  });
});
