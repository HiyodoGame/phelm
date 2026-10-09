# Security Policy

## Our posture

phelm is the open-source surface of Helm Agent — a management layer that coding agents connect to. Because the MCP ecosystem has seen a wave of supply-chain and path-traversal issues, security is a design goal here, not an afterthought:

- **Least privilege**: the MCP server exposes only read + report tools (`get_task`, `report_progress`, `get_project_context`). It never writes to your repositories, merges PRs, or touches your filesystem.
- **Per-connection tokens**: every MCP connection uses its own revocable token.
- **Full audit log**: every task fetch and progress report is recorded server-side.
- **Untrusted text isolation**: content scraped from issues/PRs/READMEs is treated as untrusted data and never allowed to trigger write actions (prompt-injection defense).
- **No secrets in repo**: CI enforces secret scanning; credentials never enter git.

## Reporting a vulnerability

Please use **GitHub private vulnerability reporting** (Security → Report a vulnerability) on this repository. Do not open a public issue.

We aim to acknowledge reports within 72 hours and will coordinate disclosure with you.

## Scope

- `packages/mcp` server and its tool schemas
- `packages/cli` (local token storage, runner process)
- `packages/contract` (schema validation)

Out of scope: the cloud service and apps (handled privately), vulnerabilities in dependencies of downstream consumers, and social engineering.
