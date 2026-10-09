import { z } from 'zod';

/**
 * ISO 8601 date-time string in UTC, for example "2026-10-09T08:30:00Z".
 * All timestamps in the contract are transported as strings to keep JSON portable.
 */
export const TimestampSchema = z.iso.datetime();

/** ISO 8601 calendar date string, for example "2026-10-09". */
export const DateOnlySchema = z.iso.date();

/** Effort bucket of a suggestion: small, medium, or large. */
export const EffortSchema = z.enum(['S', 'M', 'L']);

/** Priority ladder of a project charter, from P0 (highest) to P3 (lowest). */
export const PrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);

/** Lifecycle stage of a project. */
export const StageSchema = z.enum([
  'exploring',
  'developing',
  'testing',
  'released',
  'maintaining',
]);

/**
 * Agent integrations phelm knows how to dispatch to out of the box.
 * AgentTypeSchema itself accepts any non-empty identifier so new agents
 * do not require a contract release.
 */
export const KNOWN_AGENTS = [
  'cursor',
  'claude-code',
  'kimi-code',
  'zcode',
  'opencode',
  'deveco-code',
  'copilot',
] as const;

/** Identifier of a coding agent, for example "cursor" or "claude-code". */
export const AgentTypeSchema = z.string().min(1);

/**
 * GitHub repository reference in "owner/name" form, for example "HiyodoGame/phelm".
 * The owner follows GitHub account rules (alphanumerics, single interior hyphens,
 * max 39 chars); the repository name allows alphanumerics, ".", "_", and "-".
 */
export const RepoRefSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9_.-]+$/,
    'expected a GitHub repository reference in "owner/name" form',
  );

/** Identifier of a task on the board, for example "T-0042". */
export const TaskIdSchema = z.string().regex(/^T-\d{4}$/);

/** Inferred type of {@link TimestampSchema}. */
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Inferred type of {@link DateOnlySchema}. */
export type DateOnly = z.infer<typeof DateOnlySchema>;

/** Inferred type of {@link EffortSchema}. */
export type Effort = z.infer<typeof EffortSchema>;

/** Inferred type of {@link PrioritySchema}. */
export type Priority = z.infer<typeof PrioritySchema>;

/** Inferred type of {@link StageSchema}. */
export type Stage = z.infer<typeof StageSchema>;

/** Inferred type of {@link AgentTypeSchema}. */
export type AgentType = z.infer<typeof AgentTypeSchema>;

/** Inferred type of {@link RepoRefSchema}; a string in "owner/name" form. */
export type RepoRef = z.infer<typeof RepoRefSchema>;

/** Inferred type of {@link TaskIdSchema}. */
export type TaskId = z.infer<typeof TaskIdSchema>;
