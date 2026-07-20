# Deploying the forked Login v2 (Dokploy / containers)

This fork of Zitadel's **Login v2** adds **legacy-identifier login** (Track B): users
can sign in with a legacy identifier — a tax number (CPF, 11 digits) or a secondary
legacy username — instead of the Zitadel `loginName` the provisioner assigned. On the
username step the app calls a backend resolver, translates the typed value into the
canonical `loginName`, and then runs Zitadel's normal user lookup. On a miss or a
resolver error it falls through unchanged (**fail-open**), so real `loginName`s always
work even if the resolver is down.

- Feature code: `src/lib/server/legacy-identifier.ts` (+ tests), wired into
  `src/lib/server/loginname.ts` just before `searchUsers`.
- Deploy target: a **container** (Dokploy), not Cloudflare Workers. Next.js 16's
  `proxy.ts` (middleware) is Node-runtime-only, which is incompatible with the
  Workers/OpenNext adapter — so we ship a normal Node standalone server in a container.

---

## Files

| File | Purpose |
|---|---|
| `Dockerfile.dokploy` | Self-contained multi-stage build (deps → proto gen → client → Next standalone). Build context is the **repo root**. |
| `.env.dokploy.example` | Runtime environment template. |
| `../../.dockerignore` | Build-context hygiene (repo root). |

---

## Build

> The build context **must be the repo root** — the image needs `proto/`, `packages/`,
> and the pnpm workspace, not just `apps/login/`.

### Apple `container` CLI (local, macOS)

```sh
# from the repo root
container build -f apps/login/Dockerfile.dokploy -t im-login:latest .
```

### Docker (Dokploy build host)

```sh
docker build -f apps/login/Dockerfile.dokploy -t im-login:latest .
```

---

## Build-time configuration (baked into the image)

Next.js serializes its config and inlines `NEXT_PUBLIC_*` vars into the standalone
output **at build time**, so these are **build ARGs**, not runtime env vars. Setting
them as runtime env has no effect.

| Build ARG | Default | Meaning |
|---|---|---|
| `SERVER_ACTION_ALLOWED_ORIGINS` | `entrar.institutomix.com.br` | The public **domain**. Next rejects Server Action requests from any other origin, so this must match the hostname users hit. |
| `NEXT_PUBLIC_BASE_PATH` | `""` (empty) | URL sub-path. Empty = served at the domain root (`https://<domain>/`). Set e.g. `/ui/v2/login` to serve under a sub-path. |

### Overriding the domain at build time

```sh
container build \
  --build-arg SERVER_ACTION_ALLOWED_ORIGINS=login.example.com \
  -f apps/login/Dockerfile.dokploy -t im-login:latest .
```

Override the base path the same way:

```sh
container build \
  --build-arg NEXT_PUBLIC_BASE_PATH=/ui/v2/login \
  -f apps/login/Dockerfile.dokploy -t im-login:latest .
```

**On Dokploy:** put these in the service's **Build Args** field — *not* Environment
Variables. Because they are baked at build time, changing the domain requires a
**rebuild**, not just a restart.

---

## Runtime configuration (environment variables)

Copy `.env.dokploy.example` into the Dokploy service's environment. Key vars:

| Var | Required | Meaning |
|---|---|---|
| `ZITADEL_API_URL` | yes | Base URL of the Zitadel API/issuer this login app talks to. |
| `ZITADEL_SERVICE_USER_TOKEN` | yes | Service user PAT for the login client. (Or mount a file and set `ZITADEL_SERVICE_USER_TOKEN_FILE`.) |
| `AUTH_BACKEND_URL` | for Track B | Resolver base URL. If unset, legacy-identifier resolution is skipped and only real `loginName`s work (fail-open). |
| `AUTH_BACKEND_TOKEN` | for Track B | Shared bearer token the backend's `require_zitadel_service_account` guard checks. |
| `EMAIL_VERIFICATION` | no | `true`/`false`. |
| `OTEL_SDK_DISABLED` | no | `true` unless you run an OpenTelemetry collector. |
| `CSP_FETCH_ENABLED` | no | `false` to skip fetching iframe origins from Zitadel for CSP. |

The public domain is resolved at runtime from the `Host` / `X-Forwarded-Host` header
that Dokploy's reverse proxy sets — no domain env var is needed at runtime (only the
build-time `SERVER_ACTION_ALLOWED_ORIGINS` above).

---

## Run

```sh
container run --rm -p 3000:3000 \
  --env-file apps/login/.env.dokploy.example \
  im-login:latest
```

The server listens on port **3000**. Health endpoint: **`/ready`** (or
`<NEXT_PUBLIC_BASE_PATH>/ready` if a base path was set). A `HEALTHCHECK` is baked in.

### Dokploy service settings

- **Dockerfile path:** `apps/login/Dockerfile.dokploy`
- **Build context / root:** repository root
- **Build Args:** `SERVER_ACTION_ALLOWED_ORIGINS` (your domain), optional `NEXT_PUBLIC_BASE_PATH`
- **Environment:** the runtime vars above
- **Port:** `3000`
- **Domain:** `entrar.institutomix.com.br` (must match `SERVER_ACTION_ALLOWED_ORIGINS`)

---

## Enabling the fork in Zitadel

Point the instance's **LoginV2** feature flag + base URI at this deployment
(`https://entrar.institutomix.com.br`). Keep an instance-owner PAT handy as a lockout
safeguard before flipping the flag.
