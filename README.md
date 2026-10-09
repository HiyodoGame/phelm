# phelm

**The open-source CLI + MCP Server of [Helm Agent](#what-is-helm-agent) — an AI project manager for multi-agent development.**

English | [中文](#中文说明)

## What is Helm Agent?

You run multiple coding agents (Cursor, Claude Code, Kimi Code, ZCode, OpenCode, DevEco Code...) across several repos. Writing code is no longer the bottleneck — **deciding what to do next, in which project, and whether things are drifting off-course is.**

Helm Agent (项目舵手) is the missing management layer above your coding agents:

- **Sense** — ingests commits, PRs, issues, milestones and CI status across all your repos; reconstructs what each agent is doing.
- **Judge** — scores project health, flags risks (stalled, red CI, slipping milestone, scope drift, resource conflicts) with evidence links, and proposes next steps.
- **Dispatch** — turns approved suggestions into tasks your coding agents can pick up (via this MCP server, GitHub issue relay, or a local runner). Every plan-changing action goes through a **proposal → confirm** flow. You stay in control.

It does not write code. It manages the agents that do.

## This repository

`phelm` contains the open-source surfaces of Helm Agent:

| Package | What it does |
|---|---|
| `packages/contract` | Zod schemas + TS types shared by every surface (Task Spec, events, snapshots, risks, proposals) |
| `packages/cli` | `phelm` command line — `login`, `board`, `today`, `brief`, `runner` |
| `packages/mcp` | MCP server exposing `get_task` / `report_progress` / `get_project_context` so any MCP-capable agent can pull tasks from (and report back to) Helm |

The cloud orchestration service, web dashboard and the HarmonyOS app live in a private repository.

### Install

> Status: **pre-alpha, under active development** (P0). Packages are not published to npm yet. Star/watch to catch the first release.

### Use the MCP server (once available)

```jsonc
// e.g. in your agent's MCP config
{
  "mcpServers": {
    "phelm": {
      "command": "npx",
      "args": ["-y", "@phelm/mcp"],
      "env": { "PHELM_TOKEN": "<your token>" }
    }
  }
}
```

Your agent can then ask "what should I work on?" (`get_task`), read project context (`get_project_context`), and report progress (`report_progress`) — which feeds back into your daily briefing.

## Design principles

1. **Neutral above agents** — not competing with any coding agent; the more agents you use, the more valuable the management layer.
2. **Evidence over vibes** — every risk and suggestion cites PR/commit/CI links; conclusions without evidence are discarded.
3. **Human-in-the-loop** — plan changes ship as proposals you approve, not silent mutations.
4. **Least privilege by default** — the MCP server is read + report only; no repo write access; every call is audited. (We care about MCP security — see [SECURITY.md](SECURITY.md).)

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md).

## Related

- [GitHub Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents) — orchestration at the platform level; Helm focuses on the cross-project judgment layer above it.
- [Vibe Kanban](https://www.vibekanban.com), Conductor, Crystal — execution orchestrators (running agents in parallel); complementary, and potential dispatch targets.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). License: [Apache-2.0](LICENSE).

---

## 中文说明

**phelm** 是「项目舵手」（Helm Agent）的开源部分：CLI 与 MCP Server。

如果你同时用多个 code Agent（Cursor、Claude Code、Kimi Code、ZCode、OpenCode、DevEco Code……）推进多个项目，写代码早已不是瓶颈——**「接下来做什么、先做哪个项目、有没有跑偏」才是**。项目舵手就是你的 AI 项目经理：自动感知所有仓库的真实进度、识别风险并给出带证据的建议、把你确认过的任务下发给 code Agent 执行。所有改变计划的动作都以「提案 → 确认」进行，人始终在回路里。

- 官方文档与产品动态：开发中，首版发布前请关注本仓库
- 云端服务、Web 看板与鸿蒙端在私有仓库维护
- 安全与最小权限是我们的默认设计，详见 [SECURITY.md](SECURITY.md)

Apache-2.0 许可，欢迎 Star 与反馈。
