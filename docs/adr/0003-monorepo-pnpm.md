# ADR-0003: pnpm workspaces monorepo

- Status: proposed
- Date: 2026-10-12
- Requirements: SCL-15, NFR-11

## Decision

One repository with pnpm workspaces (`apps/*`, `services/*`, `packages/*`, `tools/*`). Scripts run with `pnpm -r`. Lockfile committed; `pnpm install --frozen-lockfile` in CI and Docker builds.

## Alternatives considered

| Option                | Why not                                                                              |
| --------------------- | ------------------------------------------------------------------------------------ |
| npm/yarn workspaces   | pnpm is faster, stricter about undeclared dependencies, and deduplicates on disk.    |
| Nx / Turborepo        | Useful caching, but another tool to learn; can be added later without restructuring. |
| Multiple repositories | Shared contracts and guardrails would drift between repos.                           |

## Why it fits SCL-11 and the government-cloud move

Each service has its own Dockerfile built from the repository root with `pnpm deploy`, producing a minimal image per service.

## Consequences

Package boundaries are enforced by ESLint import rules (business code may not import adapter implementations directly).
