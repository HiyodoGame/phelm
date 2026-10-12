import type { Board, BoardProject, HelmApi, LinkageGap } from './client.js';

/**
 * get_task assembly (T-0024) — ADVISORY semantics: the tool CONSULTS the
 * Helm Agent server for the single most urgent open linkage gap across all
 * active relations and describes it back. It writes nothing to the server
 * and has no claim/assignment semantics; dispatch semantics land when the
 * judgment layer is restored (v1 boundary).
 *
 * Ordering follows the product's canonical gap order
 * (services/worker briefing render `compareGaps`): severity desc, then
 * newest detection first, then id asc for stability.
 *
 * repo/path/actionUrl resolution follows the briefing's action-link
 * precedent (`evidenceFileUrl` in services/worker briefing render): walk the
 * evidence from the LAST entry backwards and take the
 * first one whose project is tracked on the board (the last entry is the
 * file the divergence was found in — the file to fix). The briefing reads
 * the default branch from github_repositories, which the MCP data plane
 * does not expose, so the project's CI branch approximates it ('main' when
 * unknown). Unresolvable evidence leaves repo/path/actionUrl null instead
 * of fabricating a link.
 */

/** Advisory with a task: the spec's flat advisory description. */
export interface AdvisoryWithTask {
  advisory: true;
  gapId: string;
  signal: string;
  severity: 'high' | 'medium' | 'low';
  description: string;
  impact: string;
  repo: string | null;
  path: string | null;
  actionUrl: string | null;
}

/** Advisory with no task: every chain is in sync. */
export interface AdvisoryWithoutTask {
  advisory: true;
  task: null;
  note: 'all chains are in sync';
}

export type AdvisoryResult = AdvisoryWithTask | AdvisoryWithoutTask;

const SEVERITY_RANK: Record<'high' | 'medium' | 'low', number> = { high: 2, medium: 1, low: 0 };

/** Canonical gap order (briefing render precedent): severity desc, newest first, id asc. */
export function compareGaps(a: LinkageGap, b: LinkageGap): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    b.detectedAt.localeCompare(a.detectedAt) ||
    a.id.localeCompare(b.id)
  );
}

interface ResolvedEvidence {
  repo: string;
  path: string;
  branch: string;
}

function resolveActionEvidence(
  gap: LinkageGap,
  projectById: Map<string, BoardProject>,
): ResolvedEvidence | null {
  for (let index = gap.evidence.length - 1; index >= 0; index -= 1) {
    const entry = gap.evidence[index];
    if (entry === undefined) {
      continue;
    }
    const project = projectById.get(entry.projectId);
    if (project !== undefined) {
      return {
        repo: project.repo,
        path: entry.path,
        branch: project.ci?.branch ?? 'main',
      };
    }
  }
  return null;
}

export async function buildAdvisory(client: HelmApi): Promise<AdvisoryResult> {
  const relations = (await client.fetchRelations()).filter(
    (relation) => relation.status === 'active',
  );

  const openGaps: LinkageGap[] = [];
  for (const relation of relations) {
    const response = await client.fetchOpenGapGroups(relation.id);
    openGaps.push(...response.groups.flatMap((group) => group.gaps));
  }

  if (openGaps.length === 0) {
    return { advisory: true, task: null, note: 'all chains are in sync' };
  }

  const board: Board = await client.fetchBoard();
  const projectById = new Map(board.projects.map((project) => [project.id, project]));

  openGaps.sort(compareGaps);
  const top = openGaps[0]!;
  const evidence = resolveActionEvidence(top, projectById);

  return {
    advisory: true,
    gapId: top.id,
    signal: top.signal,
    severity: top.severity,
    description: top.description,
    impact: top.impact,
    repo: evidence?.repo ?? null,
    path: evidence?.path ?? null,
    actionUrl:
      evidence === null
        ? null
        : `https://github.com/${evidence.repo}/blob/${evidence.branch}/${evidence.path}`,
  };
}
