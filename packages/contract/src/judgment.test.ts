import { describe, expect, it } from 'vitest';
import { ProposalSchema, RiskSchema, SuggestionSchema } from './judgment.js';

const risk = {
  id: 'risk-1',
  projectId: 'proj-1',
  type: 'stagnation',
  level: 'medium',
  evidence: ['https://github.com/HiyodoGame/phelm/pull/1', 'snapshot:2026-10-08'],
  impact: 'Milestone M1 due date is at risk without another advance this cycle.',
  status: 'open',
  feedback: null,
};

describe('RiskSchema', () => {
  it('parses a valid risk without feedback', () => {
    const parsed = RiskSchema.parse(risk);
    expect(parsed.feedback).toBeNull();
  });

  it('parses user feedback once given', () => {
    expect(
      RiskSchema.parse({ ...risk, status: 'acknowledged', feedback: 'acknowledged' }).feedback,
    ).toBe('acknowledged');
  });

  it('rejects unknown enums for type, level, status, and feedback', () => {
    expect(RiskSchema.safeParse({ ...risk, type: 'burnout' }).success).toBe(false);
    expect(RiskSchema.safeParse({ ...risk, level: 'critical' }).success).toBe(false);
    expect(RiskSchema.safeParse({ ...risk, status: 'closed' }).success).toBe(false);
    expect(RiskSchema.safeParse({ ...risk, feedback: 'meh' }).success).toBe(false);
  });
});

const suggestion = {
  id: 'sug-1',
  projectId: 'proj-1',
  content: 'Dispatch the schema export follow-up to zcode',
  reason: 'It unblocks the MCP integration without user effort',
  effort: 'S',
  rank: 1,
  recommendedAgent: 'zcode',
  status: 'shown',
};

describe('SuggestionSchema', () => {
  it('parses a valid suggestion', () => {
    const parsed = SuggestionSchema.parse(suggestion);
    expect(parsed.rank).toBe(1);
  });

  it('accepts the literal "user" as the recommended agent', () => {
    expect(
      SuggestionSchema.parse({ ...suggestion, recommendedAgent: 'user' }).recommendedAgent,
    ).toBe('user');
  });

  it('parses dismissal reasons alongside a dismissed status', () => {
    const parsed = SuggestionSchema.parse({
      ...suggestion,
      status: 'dismissed',
      dismissalReason: 'already handled manually',
    });
    expect(parsed.dismissalReason).toBe('already handled manually');
  });

  it('rejects unknown efforts, statuses, and non-positive ranks', () => {
    expect(SuggestionSchema.safeParse({ ...suggestion, effort: 'XL' }).success).toBe(false);
    expect(SuggestionSchema.safeParse({ ...suggestion, status: 'deleted' }).success).toBe(false);
    expect(SuggestionSchema.safeParse({ ...suggestion, rank: 0 }).success).toBe(false);
    expect(SuggestionSchema.safeParse({ ...suggestion, rank: 1.5 }).success).toBe(false);
  });
});

const proposal = {
  id: 'prop-1',
  projectId: 'proj-1',
  type: 'adjust_milestone_date',
  before: { milestoneId: 'ms-1', dueDate: '2026-10-31' },
  after: { milestoneId: 'ms-1', dueDate: '2026-11-07' },
  impact: 'Keeps the milestone realistic after the CI migration overran.',
  level: 'L2',
  status: 'pending',
};

describe('ProposalSchema', () => {
  it('parses a pending proposal', () => {
    const parsed = ProposalSchema.parse(proposal);
    expect(parsed.decidedAt).toBeUndefined();
  });

  it('parses decision metadata on decided proposals', () => {
    const parsed = ProposalSchema.parse({
      ...proposal,
      status: 'approved',
      decidedAt: '2026-10-09T09:00:00Z',
      decidedOnDevice: 'phone',
    });
    expect(parsed.decidedOnDevice).toBe('phone');
  });

  it('rejects unknown types, levels, statuses, and devices', () => {
    expect(ProposalSchema.safeParse({ ...proposal, type: 'rename_project' }).success).toBe(false);
    expect(ProposalSchema.safeParse({ ...proposal, level: 'L4' }).success).toBe(false);
    expect(ProposalSchema.safeParse({ ...proposal, status: 'cancelled' }).success).toBe(false);
    expect(ProposalSchema.safeParse({ ...proposal, decidedOnDevice: 'watch' }).success).toBe(false);
  });
});
