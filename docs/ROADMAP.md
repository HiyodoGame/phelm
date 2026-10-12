# phelm Roadmap

High-level public roadmap. Detailed planning lives in the private repository; this file tracks what's user-visible.

## Now — P0: the brain, CLI & MCP (weeks 1-4)

- [x] Monorepo scaffold + CI
- [x] `packages/contract` — shared schemas (Task Spec, events, snapshots, risks, proposals, project relations & linkage gaps)
- [x] `phelm login` (GitHub device flow, encrypted local token) + `phelm repos` (list / import)
- [x] GitHub App ingestion (commits/PRs/issues/CI → unified events → project snapshots)
- [x] Project charter with AI-drafted goals & milestones
- [ ] Project linkage — relations between repos, high-signal change detection, linkage gaps ("App changed, did the site follow?")
- [ ] Health scoring + 6 risk rule types (stalled / red CI / slipping / drift / conflict / quality)
- [ ] Daily briefing (email / Feishu webhook) + `phelm today` / `phelm brief` / `phelm board`
- [ ] MCP server: `get_task` / `report_progress` / `get_project_context`

## Next — P1: web dashboard & dispatch (weeks 5-8)

- [ ] Global board, project detail, cross-project timeline (web)
- [ ] Proposal → confirm flow with plan diff
- [ ] Task dispatch via GitHub issue relay + local `phelm runner`
- [ ] Closed beta with multi-project developers

## Later — P2/P3

- [ ] HarmonyOS companion app (daily briefing push, focus card, lightweight approvals) — China AppGallery release
- [ ] Subscription billing (via app store IAP)
- [ ] More agent integrations; optional intents/voice on HarmonyOS
- [ ] Team features (v2)

## Non-goals (for now)

- Writing code or competing with coding agents
- Autonomous unattended scheduling (human-in-the-loop only)
- Self-hosted models

---

Roadmap dates are estimates for a solo, AI-assisted development process; features may slip without notice. The plan is honest about that.
