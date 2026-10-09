import { z } from 'zod';
import {
  AgentTypeSchema,
  DateOnlySchema,
  PrioritySchema,
  RepoRefSchema,
  StageSchema,
} from './primitives.js';

/**
 * A project charter: the strategic agreement about one repository that phelm
 * tracks, distilled from the strategic document (goal, stage, cadence, ...).
 */
export const ProjectCharterSchema = z
  .object({
    id: z.string().min(1),
    repo: RepoRefSchema,
    /** Human-readable project name. */
    name: z.string().min(1),
    /** One-sentence statement of what this project is trying to achieve. */
    goal: z.string().min(1),
    stage: StageSchema,
    priority: PrioritySchema,
    /** Expected number of meaningful advances per cycle (positive integer). */
    cadence: z.number().int().positive(),
    /** Directional constraints the agents must respect, for example "no direct pushes to main". */
    constraints: z.array(z.string().min(1)),
    /** Agent integrations activated for this project. */
    agents: z.array(AgentTypeSchema),
  })
  .strict();

/** How a milestone entered the system. */
export const MilestoneSourceSchema = z.enum(['github', 'manual']);

/** A dated milestone with explicit acceptance criteria and progress tracking. */
export const MilestoneSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().min(1),
    dueDate: DateOnlySchema,
    /** Acceptance criteria that must all hold for the milestone to count as done. */
    acceptance: z.array(z.string().min(1)),
    /** Completion percentage from 0 to 100 (inclusive integer). */
    progress: z.number().int().min(0).max(100),
    source: MilestoneSourceSchema,
  })
  .strict();

/** Inferred type of {@link ProjectCharterSchema}. */
export type ProjectCharter = z.infer<typeof ProjectCharterSchema>;

/** Inferred type of {@link MilestoneSourceSchema}. */
export type MilestoneSource = z.infer<typeof MilestoneSourceSchema>;

/** Inferred type of {@link MilestoneSchema}. */
export type Milestone = z.infer<typeof MilestoneSchema>;
