import { z } from 'zod';
import { TimestampSchema } from './primitives.js';

/**
 * Closed set of change signals that linkage rules watch and linkage gaps
 * report on. Gap records and relation rules share the same enum so a gap
 * can always be traced back to the rule it violates.
 */
export const SignalKindSchema = z.enum([
  'privacy_policy',
  'version_release',
  'app_metadata',
  'permission_manifest',
  'api_contract',
  'dependency_major',
  'entry_link',
]);

/** Role a project plays inside a linkage relation. */
export const ProjectRoleSchema = z.enum(['app', 'product-page', 'portal', 'api', 'docs', 'lib']);

/**
 * Kind of relation between two linked projects. `custom` covers pairs that
 * do not fit the preset shapes; the endpoint roles still describe them.
 */
export const RelationKindSchema = z.enum([
  'app-to-product-page',
  'product-page-to-portal',
  'api-to-docs',
  'lib-to-consumers',
  'custom',
]);

/** A per-signal switch attached to a relation. */
export const RelationRuleSchema = z
  .object({
    signal: SignalKindSchema,
    /** Whether the rule is enforced; disabled rules keep the user's intent. */
    enabled: z.boolean(),
  })
  .strict();

/** One cited change that proves a linkage gap exists. */
export const LinkageEvidenceSchema = z
  .object({
    projectId: z.string().min(1),
    /** Path of the changed artifact inside the source project. */
    path: z.string().min(1),
    changedAt: TimestampSchema,
  })
  .strict();

/** A directed relation between two projects in the linkage graph. */
export const ProjectRelationSchema = z
  .object({
    id: z.string().min(1),
    sourceProjectId: z.string().min(1),
    targetProjectId: z.string().min(1),
    kind: RelationKindSchema,
    /** Role of the source project; drives relation-graph rendering and default rules. */
    sourceRole: ProjectRoleSchema.optional(),
    /** Role of the target project; drives relation-graph rendering and default rules. */
    targetRole: ProjectRoleSchema.optional(),
    /**
     * Per-signal rule switches. May be empty: a relation can be created
     * first and configured with rules later. At most one rule per signal;
     * the storage layer (task T-0060) enforces deduplication because zod
     * cannot express array uniqueness.
     */
    rules: z.array(RelationRuleSchema),
    /** How the relation came to be: inferred by phelm or created manually. */
    origin: z.enum(['inferred', 'manual']),
    /**
     * References the inference was based on (for example issue or file ids);
     * explains "why recommended" in the UI. Populated when origin is
     * "inferred"; consumers should not rely on it otherwise.
     */
    inferredFrom: z.array(z.string().min(1)).optional(),
    status: z.enum(['draft', 'active', 'paused']),
    createdAt: TimestampSchema,
  })
  .strict();

/**
 * A detected missing linkage between related projects. Modeled independently
 * of the judgment proposals because its shape and lifecycle are linkage-specific.
 */
export const LinkageGapSchema = z
  .object({
    id: z.string().min(1),
    /** Relation the gap was detected on. */
    relationId: z.string().min(1),
    signal: SignalKindSchema,
    /** User-facing description, for example "the portal entry still links to v2.2". */
    description: z.string().min(1),
    /** Human-readable description of the potential impact. */
    impact: z.string().min(1),
    /**
     * Cited changes proving the gap. At least one is required: without
     * evidence there is no gap — a hard guard against hallucinated detections.
     */
    evidence: z.array(LinkageEvidenceSchema).min(1),
    /** Root change of the impact chain; groups gaps that stem from the same source change. */
    rootChangeId: z.string().min(1),
    /** Upstream gap in the impact chain, when this gap is transitive. */
    causedByGapId: z.string().min(1).optional(),
    /** When the gap was first recorded (server clock at detection). */
    detectedAt: TimestampSchema,
    severity: z.enum(['high', 'medium', 'low']),
    status: z.enum(['open', 'resolved', 'dismissed']),
  })
  .strict();

/** Inferred type of {@link SignalKindSchema}. */
export type SignalKind = z.infer<typeof SignalKindSchema>;

/** Inferred type of {@link ProjectRoleSchema}. */
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

/** Inferred type of {@link RelationKindSchema}. */
export type RelationKind = z.infer<typeof RelationKindSchema>;

/** Inferred type of {@link RelationRuleSchema}. */
export type RelationRule = z.infer<typeof RelationRuleSchema>;

/** Inferred type of {@link LinkageEvidenceSchema}. */
export type LinkageEvidence = z.infer<typeof LinkageEvidenceSchema>;

/** Inferred type of {@link ProjectRelationSchema}. */
export type ProjectRelation = z.infer<typeof ProjectRelationSchema>;

/** Inferred type of {@link LinkageGapSchema}. */
export type LinkageGap = z.infer<typeof LinkageGapSchema>;
