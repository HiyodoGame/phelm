import { z } from 'zod';
import { AgentTypeSchema, EffortSchema, TimestampSchema } from './primitives.js';

/** Category of a detected risk. */
export const RiskTypeSchema = z.enum([
  'stagnation',
  'ci_failure',
  'delay',
  'direction_drift',
  'resource_conflict',
  'quality',
]);

/** Severity of a risk. */
export const RiskLevelSchema = z.enum(['high', 'medium', 'low']);

/** Lifecycle of a risk. */
export const RiskStatusSchema = z.enum(['open', 'acknowledged', 'resolved', 'dismissed']);

/** Feedback a user gave on how useful a risk turned out to be. */
export const RiskFeedbackSchema = z.enum(['useful', 'not_useful', 'acknowledged']);

/** A detected threat to a project's goal, backed by citable evidence. */
export const RiskSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  type: RiskTypeSchema,
  level: RiskLevelSchema,
  /** URLs or other references supporting the detection. */
  evidence: z.array(z.string().min(1)),
  /** Human-readable description of the potential impact. */
  impact: z.string(),
  status: RiskStatusSchema,
  /** User feedback on this risk; null while no feedback has been given. */
  feedback: RiskFeedbackSchema.nullable(),
});

/** Lifecycle of a suggestion shown to the user. */
export const SuggestionStatusSchema = z.enum([
  'shown',
  'adopted',
  'dispatched',
  'snoozed',
  'dismissed',
]);

/** Executor recommendation: a coding agent, or the literal "user". */
export const RecommendedAgentSchema = z.union([AgentTypeSchema, z.literal('user')]);

/** A concrete next action phelm proposes to the user, ranked against its peers. */
export const SuggestionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** Actionable content of the suggestion, phrased for the briefing. */
  content: z.string().min(1),
  /** Why phelm believes this action is worth taking now. */
  reason: z.string().min(1),
  effort: EffortSchema,
  /** Sort rank among sibling suggestions; 1 is the top suggestion. */
  rank: z.number().int().positive(),
  recommendedAgent: RecommendedAgentSchema.optional(),
  status: SuggestionStatusSchema,
  /** Present when status is "dismissed", to label the feedback loop. */
  dismissalReason: z.string().optional(),
});

/** Kind of adjustment a proposal requests. */
export const ProposalTypeSchema = z.enum([
  'adjust_milestone_date',
  'adjust_priority',
  'adjust_scope',
  'pause_direction',
  'switch_agent',
]);

/** Decision weight of a proposal; L1 is lightest, L3 is heaviest. */
export const ProposalLevelSchema = z.enum(['L1', 'L2', 'L3']);

/** Lifecycle of a proposal. */
export const ProposalStatusSchema = z.enum([
  'draft',
  'pending',
  'approved',
  'rejected',
  'modified',
  'applied',
]);

/** Device on which the user decided the proposal. */
export const ProposalDeviceSchema = z.enum(['phone', 'tablet', 'pc', 'web', 'cli']);

/** A proposed change to the project's plan awaiting user approval. */
export const ProposalSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  type: ProposalTypeSchema,
  /** State before the change; shape is type-specific and intentionally loose. */
  before: z.record(z.string(), z.unknown()),
  /** State after the change; shape is type-specific and intentionally loose. */
  after: z.record(z.string(), z.unknown()),
  /** Human-readable description of the expected impact. */
  impact: z.string(),
  level: ProposalLevelSchema,
  status: ProposalStatusSchema,
  /** Present once the proposal has been decided. */
  decidedAt: TimestampSchema.optional(),
  decidedOnDevice: ProposalDeviceSchema.optional(),
});

/** Inferred type of {@link RiskTypeSchema}. */
export type RiskType = z.infer<typeof RiskTypeSchema>;

/** Inferred type of {@link RiskLevelSchema}. */
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/** Inferred type of {@link RiskStatusSchema}. */
export type RiskStatus = z.infer<typeof RiskStatusSchema>;

/** Inferred type of {@link RiskFeedbackSchema}. */
export type RiskFeedback = z.infer<typeof RiskFeedbackSchema>;

/** Inferred type of {@link RiskSchema}. */
export type Risk = z.infer<typeof RiskSchema>;

/** Inferred type of {@link SuggestionStatusSchema}. */
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;

/** Inferred type of {@link RecommendedAgentSchema}. */
export type RecommendedAgent = z.infer<typeof RecommendedAgentSchema>;

/** Inferred type of {@link SuggestionSchema}. */
export type Suggestion = z.infer<typeof SuggestionSchema>;

/** Inferred type of {@link ProposalTypeSchema}. */
export type ProposalType = z.infer<typeof ProposalTypeSchema>;

/** Inferred type of {@link ProposalLevelSchema}. */
export type ProposalLevel = z.infer<typeof ProposalLevelSchema>;

/** Inferred type of {@link ProposalStatusSchema}. */
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/** Inferred type of {@link ProposalDeviceSchema}. */
export type ProposalDevice = z.infer<typeof ProposalDeviceSchema>;

/** Inferred type of {@link ProposalSchema}. */
export type Proposal = z.infer<typeof ProposalSchema>;
