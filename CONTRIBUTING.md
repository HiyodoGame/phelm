# Contributing to phelm

Thanks for your interest! phelm is pre-alpha — the best early contributions are issue reports and MCP integration feedback from real agent workflows.

## Ground rules

- **Scope discipline**: changes should map to a tracked issue or roadmap item. No silent scope expansion.
- **No secrets, no commercial content**: this is a public repo — never commit credentials, internal URLs, pricing, or business/compliance documents.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Work on a branch named `helm/<topic>`; PR description should reference the issue it resolves.

## Development setup

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Monorepo layout: `packages/contract` (schemas — single source of truth), `packages/cli`, `packages/mcp`.

**Schema changes** in `packages/contract` require: updated zod schemas, updated JSON Schema exports, contract tests, and a changeset note. Consumers depend on tagged versions.

## Security

See [SECURITY.md](SECURITY.md). Do NOT open public issues for vulnerabilities.

## License

By contributing you agree your contributions are licensed under [Apache-2.0](LICENSE).
