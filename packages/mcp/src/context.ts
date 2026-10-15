import type { ProjectRelation } from '@phelm/contract';
import type { BoardProject, HelmApi, LinkageGap } from './client.js';

/**
 * get_project_context assembly (T-0024): the snapshot + linkage-context
 * outlet. Board health (health score, CI, milestones, open risks) per
 * project, joined with the ACTIVE relations touching the project and each
 * relation's open gaps (id / severity / description), plus the latest daily
 * briefing when one exists (best effort: no briefing generated yet simply
 * omits the field).
 *
 * Read-only: every input is a read against the Helm Agent data plane.
 */

export interface ContextOptions {
  /** Scope to one tracked repository ("owner/name"); omit for all projects. */
  repo?: string;
}

/** Open-gap summary the context carries: id / severity / description. */
export interface ContextGap {
  id: string;
  severity: 'high' | 'medium' | 'low';
  description: string;
}

export interface ContextRelation {
  id: string;
  kind: string;
  /** Which end of the relation this project sits on. */
  direction: 'source' | 'target';
  /** The other side's project id (board lookups resolve name/repo). */
  counterpartyProjectId: string;
  /** Resolved from the board; null when the counterparty is not tracked. */
  counterpartyName: string | null;
  counterpartyRepo: string | null;
  openGaps: ContextGap[];
}

export interface ContextProject {
  id: string;
  name: string;
  repo: string;
  goal: string;
  stage: string;
  priority: string;
  snapshot: BoardProject['snapshot'];
  ci: BoardProject['ci'];
  milestones: BoardProject['milestones'];
  risks: BoardProject['risks'];
  relations: ContextRelation[];
}

export interface LatestBriefing {
  date: string;
  stats: {
    totalGaps: number;
    relations: number;
    maxSeverity: 'high' | 'medium' | 'low' | 'none';
    chains: number;
    pendingDrafts: number;
    draftRelations: number;
  };
  contentMd: string;
}

/** The tool's structured result for a repo that is not on the board. */
export interface ProjectNotTracked {
  tracked: false;
  repo: string;
  message: string;
}

export interface ProjectContext {
  tracked: true;
  /** Board generation timestamp (the snapshot moment, not call time). */
  generatedAt: string;
  projects: ContextProject[];
  /** Latest daily briefing; omitted when none has been generated yet. */
  latestBriefing?: LatestBriefing;
}

export type ProjectContextResult = ProjectContext | ProjectNotTracked;

function toContextRelation(
  relation: ProjectRelation,
  direction: 'source' | 'target',
  projectById: Map<string, BoardProject>,
  gaps: readonly LinkageGap[],
): ContextRelation {
  const counterpartyProjectId =
    direction === 'source' ? relation.targetProjectId : relation.sourceProjectId;
  const counterparty = projectById.get(counterpartyProjectId);
  return {
    id: relation.id,
    kind: relation.kind,
    direction,
    counterpartyProjectId,
    counterpartyName: counterparty?.name ?? null,
    counterpartyRepo: counterparty?.repo ?? null,
    openGaps: gaps.map((gap) => ({
      id: gap.id,
      severity: gap.severity,
      description: gap.description,
    })),
  };
}

/**
 * Build the context payload. Scoping happens BEFORE gap fetching: a
 * repo-scoped context only pays for the relations that actually touch the
 * scoped projects, and gaps are fetched once per relevant relation and
 * shared between the two endpoint projects in the all-projects view. A gap
 * fetch failure surfaces as a tool error — a half-context is worse than a
 * loud failure.
 */
export async function buildProjectContext(
  client: HelmApi,
  options: ContextOptions = {},
): Promise<ProjectContextResult> {
  const board = await client.fetchBoard();

  const scoped =
    options.repo === undefined
      ? board.projects
      : board.projects.filter((project) => project.repo === options.repo);
  if (options.repo !== undefined && scoped.length === 0) {
    return {
      tracked: false,
      repo: options.repo,
      message: `project not tracked: no board project has repo "${options.repo}"`,
    };
  }

  const projectById = new Map(board.projects.map((project) => [project.id, project]));
  const scopedIds = new Set(scoped.map((project) => project.id));
  const relations = await client.fetchRelations();
  // Active relations touching a scoped project; already narrowed to the
  // scope so gap fetches do not run for relations nothing below will use.
  const relevantRelations = relations.filter(
    (relation) =>
      relation.status === 'active' &&
      (scopedIds.has(relation.sourceProjectId) || scopedIds.has(relation.targetProjectId)),
  );

  // Parallel (review P2 fix): same serial round-trip argument as buildAdvisory.
  const gapResponses = await Promise.all(
    relevantRelations.map((relation) => client.fetchOpenGapGroups(relation.id)),
  );
  const gapsByRelation = new Map<string, LinkageGap[]>(
    relevantRelations.map((relation, index) => [
      relation.id,
      gapResponses[index]!.groups.flatMap((group) => group.gaps),
    ]),
  );

  const projects: ContextProject[] = scoped.map((project) => ({
    id: project.id,
    name: project.name,
    repo: project.repo,
    goal: project.goal,
    stage: project.stage,
    priority: project.priority,
    snapshot: project.snapshot,
    ci: project.ci,
    milestones: project.milestones,
    risks: project.risks,
    relations: relevantRelations.flatMap((relation) => {
      if (relation.sourceProjectId === project.id) {
        return [
          toContextRelation(relation, 'source', projectById, gapsByRelation.get(relation.id) ?? []),
        ];
      }
      if (relation.targetProjectId === project.id) {
        return [
          toContextRelation(relation, 'target', projectById, gapsByRelation.get(relation.id) ?? []),
        ];
      }
      return [];
    }),
  }));

  const briefing = await client.fetchLatestBriefing();
  const context: ProjectContext = {
    tracked: true,
    generatedAt: board.generatedAt,
    projects,
    ...(briefing === null ? {} : { latestBriefing: briefing }),
  };
  return context;
}
