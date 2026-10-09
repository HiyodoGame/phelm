import { z } from 'zod';
import { MilestoneSchema, ProjectCharterSchema } from './charter.js';
import { AgentConnectionSchema, TaskSchema, TaskSpecSchema } from './dispatch.js';
import { EventSchema, SnapshotSchema } from './events.js';
import { UserSchema, DecisionLogSchema } from './identity.js';
import { ProposalSchema, RiskSchema, SuggestionSchema } from './judgment.js';

/**
 * A JSON Schema document as produced by zod v4's native converter.
 * All properties are optional per the JSON Schema specification; treat unknown
 * keys as opaque when consuming.
 */
export type JsonSchema = z.core.JSONSchema.BaseSchema;

/** Entities exported by {@link exportJsonSchemas}, keyed by name. */
export const CONTRACT_SCHEMA_ENTITIES = [
  'User',
  'ProjectCharter',
  'Milestone',
  'Event',
  'Snapshot',
  'Risk',
  'Suggestion',
  'Proposal',
  'TaskSpec',
  'Task',
  'AgentConnection',
  'DecisionLog',
] as const;

/** Entity names of the JSON Schema export. */
export type ContractSchemaEntity = (typeof CONTRACT_SCHEMA_ENTITIES)[number];

function toJSONSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: 'draft-2020-12' });
}

/**
 * Converts every contract entity to a standalone JSON Schema (draft 2020-12).
 * Each entry is self-contained (no $refs), so files can be published individually.
 */
export function exportJsonSchemas(): Record<ContractSchemaEntity, JsonSchema> {
  return {
    User: toJSONSchema(UserSchema),
    ProjectCharter: toJSONSchema(ProjectCharterSchema),
    Milestone: toJSONSchema(MilestoneSchema),
    Event: toJSONSchema(EventSchema),
    Snapshot: toJSONSchema(SnapshotSchema),
    Risk: toJSONSchema(RiskSchema),
    Suggestion: toJSONSchema(SuggestionSchema),
    Proposal: toJSONSchema(ProposalSchema),
    TaskSpec: toJSONSchema(TaskSpecSchema),
    Task: toJSONSchema(TaskSchema),
    AgentConnection: toJSONSchema(AgentConnectionSchema),
    DecisionLog: toJSONSchema(DecisionLogSchema),
  };
}

/**
 * Renders every exported schema as stable file content, keyed by
 * `<Entity>.json`. Pure (no IO) so it stays testable; the export script
 * only writes these strings to disk.
 */
export function renderJsonSchemaFiles(): Record<ContractSchemaEntity, string> {
  const rendered = {} as Record<ContractSchemaEntity, string>;
  for (const [entity, schema] of Object.entries(exportJsonSchemas())) {
    rendered[entity as ContractSchemaEntity] = `${JSON.stringify(schema, null, 2)}\n`;
  }
  return rendered;
}
