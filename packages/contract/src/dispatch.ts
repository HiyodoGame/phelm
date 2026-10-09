import { z } from 'zod';
import { AgentTypeSchema, RepoRefSchema, TaskIdSchema } from './primitives.js';

/**
 * Default branch name used when a task spec omits one:
 * `helm/<taskId>`, for example "helm/T-0042".
 */
export function defaultBranchFor(taskId: string): string {
  return `helm/${taskId}`;
}

/** Context attached to a task spec so the agent can orient itself. */
export const TaskContextSchema = z
  .object({
    /** Issues relevant to the task, as ids or URLs. */
    issues: z.array(z.string().min(1)),
    /** Files the agent is expected to touch or read first. */
    files: z.array(z.string().min(1)),
    /** Directional constraints in addition to the project charter. */
    constraints: z.array(z.string().min(1)),
  })
  .strict();

/** Guardrails applied to every dispatch of this task. */
export const TaskLimitsSchema = z
  .object({
    /** Wall-clock budget for one dispatch run, in minutes. */
    maxDurationMinutes: z.number().int().positive().optional(),
    noDirectPushToMain: z.boolean().default(true),
    requirePr: z.boolean().default(true),
  })
  .strict();

/**
 * The nested contract handed to an agent when a task is dispatched
 * (strategic document §5.7). Pure data; no IO or storage concerns.
 */
export const TaskSpecSchema = z
  .object({
    taskId: TaskIdSchema,
    /** Project (charter) id the task belongs to. */
    project: z.string().min(1),
    repo: RepoRefSchema,
    /**
     * Branch the agent works on. When omitted, dispatchers use
     * {@link defaultBranchFor} (`helm/<taskId>`).
     */
    branch: z
      .string()
      .min(1)
      .optional()
      .describe('Defaults to helm/<taskId>; see defaultBranchFor().'),
    /** Outcome-focused statement of what "done" means for this task. */
    goal: z.string().min(1),
    context: TaskContextSchema,
    /** Acceptance criteria the resulting PR is reviewed against. */
    acceptance: z.array(z.string().min(1)),
    targetAgent: AgentTypeSchema,
    limits: TaskLimitsSchema,
  })
  .strict();

/** Transport over which a task is dispatched to an agent. */
export const TaskChannelSchema = z.enum(['issue_relay', 'cli_runner', 'mcp']);

/** Lifecycle of a dispatched task. */
export const TaskStatusSchema = z.enum([
  'created',
  'confirmed',
  'dispatched',
  'running',
  'pr_opened',
  'done',
  'failed',
]);

/** A board task tracked from creation through its resulting PR. */
export const TaskSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    spec: TaskSpecSchema,
    targetAgent: AgentTypeSchema,
    channel: TaskChannelSchema,
    status: TaskStatusSchema,
    /** Pull request URL once one has been opened. */
    prUrl: z.url().optional(),
    /** Free-form outcome payload set when the task finishes or fails. */
    result: z.unknown().optional(),
  })
  .strict();

/** Lifecycle of an agent connection. */
export const AgentConnectionStatusSchema = z.enum(['connected', 'disabled', 'error']);

/** A user's standing connection to one agent integration over one channel. */
export const AgentConnectionSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    agentType: AgentTypeSchema,
    channel: TaskChannelSchema,
    /** Reference to credentials stored in KMS; never the credentials themselves. */
    credentialsRef: z.string().min(1),
    status: AgentConnectionStatusSchema,
  })
  .strict();

/** Inferred type of {@link TaskContextSchema}. */
export type TaskContext = z.infer<typeof TaskContextSchema>;

/** Inferred type of {@link TaskLimitsSchema}. */
export type TaskLimits = z.infer<typeof TaskLimitsSchema>;

/** Inferred type of {@link TaskSpecSchema}. */
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/** Inferred type of {@link TaskChannelSchema}. */
export type TaskChannel = z.infer<typeof TaskChannelSchema>;

/** Inferred type of {@link TaskStatusSchema}. */
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Inferred type of {@link TaskSchema}. */
export type Task = z.infer<typeof TaskSchema>;

/** Inferred type of {@link AgentConnectionStatusSchema}. */
export type AgentConnectionStatus = z.infer<typeof AgentConnectionStatusSchema>;

/** Inferred type of {@link AgentConnectionSchema}. */
export type AgentConnection = z.infer<typeof AgentConnectionSchema>;
