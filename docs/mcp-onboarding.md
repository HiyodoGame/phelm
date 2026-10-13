# Connecting a coding agent to Helm Agent (MCP onboarding)

This guide wires any MCP-capable coding agent — Cursor, ZCode, Claude Code,
OpenCode, Kimi Code, ... — to a running Helm Agent server, so the agent can
ask "what should I work on?" and report progress back. Everything the agent
can do is **read + report**: it gets a dedicated, revocable **MCP connection
token**, never your operator credentials, and every request it makes is
recorded in the server-side audit log.

The steps:

1. [Prerequisites](#1-prerequisites)
2. [Issue an MCP token](#2-issue-an-mcp-token-operator-once)
3. [Configure your agent](#3-configure-your-agent)
4. [Verify](#4-verify)
5. [Troubleshooting](#5-troubleshooting)
6. [Security notes](#6-security-notes)

## 1. Prerequisites

- **A running Helm Agent server** (the private-registry orchestration service)
  and its base URL, e.g. `http://localhost:3000`. It must be started with
  `API_AUTH_TOKEN` configured — if it was not, every MCP endpoint answers
  `503` (fail-closed); ask the operator to set it and restart.
- **Your operator token**: the value of the server's `API_AUTH_TOKEN`. You
  need it exactly once, to issue an MCP token in step 2. The agent itself
  never holds or sees it.
- **Node.js >= 22** on the machine the agent runs on. The MCP server ships in
  this repository (`packages/mcp`); the npm packages are not published yet
  (pre-alpha), so build from source:

  ```bash
  git clone https://github.com/HiyodoGame/phelm.git   # or your fork
  cd phelm
  pnpm install
  pnpm -r build
  ```

  The entry point you will reference in agent configs is
  `packages/mcp/dist/transport.js` (the `phelm-mcp` binary of the
  `@phelm/mcp` workspace package).

## 2. Issue an MCP token (operator, once)

With your operator token, create one MCP connection token per agent
(descriptive label, e.g. `<client> on <machine>`; 1–80 characters):

```bash
curl -s -X POST http://localhost:3000/mcp/tokens \
  -H "Authorization: Bearer <your API_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"label": "cursor on alice-laptop"}'
# → 201 {"id":"mcptok_…","token":"mcp_…","label":"cursor on alice-laptop","createdAt":"…"}
```

**The plaintext `mcp_…` token is shown exactly once.** It is stored
server-side only as a sha256 fingerprint — it is not logged, not recoverable.
Copy it into the agent config (step 3) now; if you lose it, revoke the token
and issue a fresh one.

Lifecycle management (operator token required for all of these):

```bash
# list tokens (shows lifecycle metadata, never the secrets)
curl -s http://localhost:3000/mcp/tokens \
  -H "Authorization: Bearer <your API_AUTH_TOKEN>"

# revoke — effective immediately, idempotent (204)
curl -s -X DELETE http://localhost:3000/mcp/tokens/<token id> \
  -H "Authorization: Bearer <your API_AUTH_TOKEN>"
```

## 3. Configure your agent

The MCP server runs on the same machine as your agent and talks to the Helm
Agent server over HTTP. Credentials live entirely in two environment
variables:

| Variable         | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `HELM_API_URL`   | Helm Agent API base URL (default `http://localhost:3000`)   |
| `HELM_API_TOKEN` | the `mcp_…` token from step 2 (required)                    |

### Cursor

`.cursor/mcp.json` (project scope; use `~/.cursor/mcp.json` for global scope):

```json
{
  "mcpServers": {
    "phelm": {
      "command": "node",
      "args": ["</absolute/path/to>/phelm/packages/mcp/dist/transport.js"],
      "env": {
        "HELM_API_URL": "http://localhost:3000",
        "HELM_API_TOKEN": "<the mcp_… token you issued above>"
      }
    }
  }
}
```

### ZCode / other generic stdio clients

The contract is the same `command` / `args` / `env` triple; only the config
file's location differs per client (ZCode, Claude Code, OpenCode, ... — check
that client's docs for where its MCP config lives). Concretely: run
`node </absolute/path/to>/phelm/packages/mcp/dist/transport.js` with the two
environment variables above, over stdio.

A missing `HELM_API_TOKEN` never crashes the server: tools answer with a
clean "token not configured" error until you fix the env and restart the
client's MCP session.

### HTTP mode (instead of stdio)

```bash
node </absolute/path/to>/phelm/packages/mcp/dist/transport.js --http 6280
# → MCP Streamable HTTP on http://127.0.0.1:6280/mcp
```

- Binds **`127.0.0.1` only**; requests are stateless (no session ids).
- DNS-rebinding protection: the `Host` header must be `127.0.0.1:<port>` or
  `localhost:<port>` — anything else is rejected.
- Any request carrying a browser `Origin` header is rejected (`403`): MCP
  over loopback serves non-browser clients only.
- The HTTP endpoint has **no auth of its own** — the MCP token gates the
  Helm Agent API behind it. Never expose the port beyond localhost.

## 4. Verify

Enable/restart the server entry in your MCP client. You should see three
tools:

- `get_project_context` — board health, active relations and open gaps, per
  project (optional `repo` filter, e.g. `"owner/name"`).
- `get_task` — the single most urgent open linkage gap, as an **advisory**.
- `report_progress` — report status back; validated and persisted
  server-side.

Smoke checks:

1. Call `get_task` (no arguments). Either it returns a flat advisory:

   ```json
   {
     "advisory": true,
     "gapId": "gap_…",
     "signal": "…",
     "severity": "high",
     "description": "…",
     "impact": "…",
     "repo": "owner/name",
     "path": "src/…",
     "actionUrl": "https://github.com/owner/name/blob/main/src/…"
   }
   ```

   (`repo`/`path`/`actionUrl` are `null` when the evidence cannot be resolved
   to a tracked project.) Or, when every chain is in sync:

   ```json
   { "advisory": true, "task": null, "note": "all chains are in sync" }
   ```

   Advisory only: nothing is claimed, assigned or reserved — there is no
   claim semantics yet.

2. Call `report_progress` with `status` (required, one of `"in_progress"`,
   `"done"`, `"blocked"`), optional `gapId` and optional `note` (free text,
   ≤ 2000 chars). A persisted report answers:

   ```json
   { "received": true, "audited": true }
   ```

   `audited: true` is a durability claim: the report reached the server-side
   audit log before the acknowledgment was written.

Smoke test without a full client (stdio mode is JSON-RPC 2.0 over
stdin/stdout, one message per line — any MCP client does this for you):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node packages/mcp/dist/transport.js
```

The output (JSON-RPC responses on stdout) must list the three tools;
diagnostics go to stderr only.

## 5. Troubleshooting

Tool calls never throw raw network errors at the agent — every failure maps
to a single-line message on the tool result (with `isError: true`):

| Tool message                                                                 | Cause                                                    | Fix                                                                        |
| ---------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `cannot reach the Helm Agent server at <url> (is it running?)`               | `HELM_API_URL` wrong, or the server is down              | Fix the URL / start the server                                              |
| `the Helm Agent server rejected the API token (check HELM_API_TOKEN)`        | token mistyped, or revoked (revocation is immediate)     | Fix the env, or issue a fresh token (step 2)                                |
| `token not configured: set HELM_API_TOKEN (the Helm Agent API token)`        | `HELM_API_TOKEN` missing from the MCP config env         | Add the env entry, restart the client's MCP session                         |
| `the Helm Agent server has its API disabled (API_AUTH_TOKEN unconfigured server-side)` | the Helm server itself runs without `API_AUTH_TOKEN` | Operator: set `API_AUTH_TOKEN` on the server and restart it            |
| `report_progress` answers `{"received": true, "audited": false, "degraded": true}` | the server at `HELM_API_URL` predates the report intake (or the URL points at something else that answers 404) | Check the MCP server's stderr for the structured `report_progress_degraded` line (it names the URL actually used); upgrade the Helm server or fix the URL |

HTTP-mode extras:

- `403 "browser-originated requests are not allowed on this endpoint"` — the
  request carried an `Origin` header. Use a non-browser MCP client.
- Host-header rejection — connect to `http://127.0.0.1:<port>/mcp` or
  `http://localhost:<port>/mcp` exactly (no other hostname).
- Nothing but `/mcp` is served; anything else answers `404`.

The MCP server logs one-line structured diagnostics to **stderr** (never
stdout — in stdio mode stdout is the protocol stream), so check your client's
MCP log there first.

## 6. Security notes

- **Least privilege.** An MCP token reaches only the data plane:
  `GET /board`, `GET /relations`, `GET /relations/:id/gaps`,
  `GET /briefings/latest` and `POST /mcp/reports`. Management endpoints
  (token issue/revoke, ingest, configuration, ...) treat an `mcp_` bearer as
  just another wrong credential: the same uniform `401` as everywhere else.
- **Audited.** Every authenticated MCP request and every accepted report is
  recorded in the server-side audit log — which connection token did what,
  when. Issue one token per agent with a descriptive label so the audit
  trail maps to a specific agent on a specific machine.
- **Revocable.** `DELETE /mcp/tokens/<id>` takes effect immediately and is
  idempotent. To shut an agent out, revoke — nothing else is touched.
- **Show-once secret.** The plaintext token is stored server-side only as a
  sha256 fingerprint. Losing it means revoking and re-issuing, not
  "recovering" it.
- **The label is a human hint, not a secret** — never put credentials in it.
- **Prefix discipline.** `mcp_` is reserved for MCP connection tokens; an
  operator token must not start with it, and an `mcp_` token can never act
  as an operator token.
- **HTTP mode is loopback-only** with Origin rejection and a Host allowlist
  (see step 3). It still carries no auth of its own — do not expose it
  beyond localhost.
- See [SECURITY.md](../SECURITY.md) for the repository's security policy.
