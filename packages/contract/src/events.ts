import { z } from 'zod';
import { AgentTypeSchema, DateOnlySchema, TimestampSchema } from './primitives.js';

/** Kind of repository activity an Event represents. */
export const EventTypeSchema = z.enum(['commit', 'pr', 'issue', 'ci', 'agent_run']);

/**
 * A single observed activity in a project (commit, pull request, issue, CI run,
 * or agent run). The payload is intentionally loose; producers own its shape.
 */
export const EventSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    type: EventTypeSchema,
    /** Login or system that performed the activity. */
    actor: z.string().min(1),
    /** Present when the activity was produced by a coding agent. */
    agent: AgentTypeSchema.optional(),
    /** Type-specific payload; consumers must treat unknown keys as opaque. */
    payload: z.record(z.string(), z.unknown()),
    ts: TimestampSchema,
  })
  .strict();

/**
 * Keys of the health factors that feed the daily health score.
 * A Snapshot must carry a value for every key.
 */
export const HEALTH_FACTOR_KEYS = [
  'milestone_progress',
  'activity',
  'ci_health',
  'direction_alignment',
  'open_blockers',
] as const;

/** Identifier of one health factor feeding the health score. */
export const HealthFactorKeySchema = z.enum(HEALTH_FACTOR_KEYS);

/** Daily roll-up of a project's state used to drive briefings and risk detection. */
export const SnapshotSchema = z
  .object({
    projectId: z.string().min(1),
    date: DateOnlySchema,
    /** Overall health score from 0 to 100 (inclusive integer). */
    healthScore: z.number().int().min(0).max(100),
    /** Per-factor scores; a value is required for every {@link HealthFactorKey}. */
    factors: z.record(HealthFactorKeySchema, z.number()),
    /** One-line narrative summary shown in the briefing. */
    summary: z.string(),
  })
  .strict();

/** Inferred type of {@link EventTypeSchema}. */
export type EventType = z.infer<typeof EventTypeSchema>;

/** Inferred type of {@link EventSchema}. */
export type Event = z.infer<typeof EventSchema>;

/** Inferred type of {@link HealthFactorKeySchema}. */
export type HealthFactorKey = z.infer<typeof HealthFactorKeySchema>;

/** Inferred type of {@link SnapshotSchema}. */
export type Snapshot = z.infer<typeof SnapshotSchema>;
