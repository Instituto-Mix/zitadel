# ZITADEL Login App Guide for AI Agents

## Context
The **Login App** (`apps/login`) provides the user interface for authentication flows (Login, Register, MFA, etc.). It is built with Next.js and React.

## Hard project boundary
- **Edit only `apps/login/**`.** Do not modify, generate files in, stage, or resolve
  merge conflicts in any other part of the ZITADEL repository, including root
  files, the backend demo client, `proto/`, and `packages/`. This restriction
  takes precedence over broader repository guidance.
- Read outside `apps/login/` only when strictly necessary for a specific
  Login v2 dependency or investigation, and inspect the smallest relevant
  portion. Other projects are for rare exploration, not implementation.
- If Login v2 work truly requires a change outside `apps/login/`, stop and
  request explicit authorization before touching that path. During upstream
  pulls or merges, preserve this fork's `apps/login/AGENTS.md` and Login v2
  customizations; do not extend the merge work into other projects.

## Entrar Deployment Context
- This fork deploys Login v2 as the user-facing UI at `https://entrar.institutomix.com.br`; it authenticates against the ZITADEL OIDC issuer/API at `https://id.institutomix.com.br`. The login UI is not the issuer.
- Use the Entrar origin for passkey enrollment and browser login flows. Passkeys enrolled on `id.institutomix.com.br` do not automatically work on `entrar.institutomix.com.br`; browser credentials are origin-bound.
- Preserve fork-specific legacy-identifier and first-access customizations when syncing upstream; do not overwrite them with upstream Login changes.
- Avoid hardcoded user or organization IDs; use configuration or runtime context.
- For deployment context, consult the repository root `AGENTS.md` and `README.dokploy.md`.
- Preserve this fork-maintained `AGENTS.md` during upstream merges; our guidance takes precedence over conflicting upstream content (see root `AGENTS.md`).

## Key Technology
- **Framework**: Next.js (React).
- **Styling**: TailwindCSS, configured via `apps/login/tailwind.config.mjs`.
- **Data Fetching**: Primarily server-side interaction with ZITADEL APIs via `@zitadel/client` or direct gRPC calls where applicable.
- **Language**: TypeScript.

## Architecture & Conventions
- **Routing**: Uses the Next.js App Router (routes are defined under `src/app/`).
- **Composability**: Components should be small and reusable.
- **State**: Critical authentication state is often managed via URL parameters (Auth Requests) and cookies/sessions.
- For a strictly necessary shared API question, consult only the relevant
  portion of `packages/AGENTS.md` or `proto/AGENTS.md`; those paths remain
  read-only under the hard project boundary above.

## Dependency hygiene
- Before shipping Login v2 changes, check direct dependencies with
  `pnpm --filter @zitadel/login outdated --format json` from the repository
  root and run `pnpm audit --json` from `apps/login/`. These commands can exit
  nonzero when they find outdated packages or advisories; inspect their output.
- The audit checks the workspace lockfile, not just Login v2. Distinguish
  advisory paths beginning `apps__login>` from unrelated workspace projects.
  Prioritize patched releases for Login v2 security advisories, then verify
  build and tests. Use pnpm, not `npm audit` or `npm install`, for this workspace.
- Updating dependencies requires the root `pnpm-lock.yaml`; the hard project
  boundary above still applies. Request explicit authorization before changing
  that file, and never leave `apps/login/package.json` out of sync with it.
- To verify Login without generating files in shared projects, run
  `pnpm run build` and `pnpm run test-unit` from `apps/login/`. Nx targets below
  can invoke shared proto/client prerequisites; honor the hard boundary.
- Keep Login's protobuf runtime compatible with the unchanged shared client/proto
  packages. A newer peer resolution can produce incompatible RPC descriptor types;
  do not update shared packages to bypass this project's boundary.

## Verified Nx Targets
- **Dev Server**: `pnpm nx run @zitadel/login:dev`
- **Build**: `pnpm nx run @zitadel/login:build`
- **Lint**: `pnpm nx run @zitadel/login:lint`
- **Test (all)**: `pnpm nx run @zitadel/login:test`
- **Test (unit)**: `pnpm nx run @zitadel/login:test-unit`
- **Test (integration)**: `pnpm nx run @zitadel/login:test-integration`
- **Pack (Docker)**: `pnpm nx run @zitadel/login:pack` — builds a local Docker image `zitadel/zitadel-login:local`. Requires Docker daemon.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
