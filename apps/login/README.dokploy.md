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

## First access via the legacy ERP password

Provisioned users have no Zitadel password, and the email fallback is dead for them:
about half the ERP addresses are missing or wrong, and provisioning substitutes the
undeliverable placeholder `email@invalido.troque`. So first access bridges through the
backend instead.

1. The user types their `loginName` and their **ERP** password. Zitadel's own password
   check fails (there is no Zitadel password yet).
2. Only if the user has **no** `PASSWORD` auth method, the app POSTs
   `{login_name, password}` to `{AUTH_BACKEND_URL}/auth/legacy-migrate`. A `200` means
   the ERP digest matched and carries a **password-reset code**; `409` (already has a
   password) and `403` (anything else) are deliberately indistinguishable to the user.
3. The ERP password is **proof of identity only — it is never installed**. The ERP
   stores an unsalted MD5 that cannot be inspected or reversed, so there is no way to
   know whether it satisfies Zitadel's complexity policy, and most legacy passwords do
   not. The user is redirected to `/password/first-access` to choose a new password;
   Zitadel enforces its policy there and its validation message is shown verbatim so
   the user can retry — a rejected password does not consume the reset code, so no
   second ERP round-trip is needed. **This is the mandatory rotation** — there is no
   separate forced-change screen.
4. The app then signs the user in with the newly chosen password and continues the
   normal session/MFA/redirect flow.

The provisioner pins Zitadel's `userId` to the ERP pessoa id at creation, so for a
provisioned user the two ids are the same value. The app still spends the code against
the id **it** resolved, never the one in the response body; if the two disagree the user
was created out-of-band, the code belongs to a different id, and the app **fails closed**
with an integrity error rather than claiming the password was wrong.

The reset code is bearer-grade: it authorizes setting that user's password. Zitadel
issues it with a 1 h TTL (`SECRET_GENERATOR_TYPE_PASSWORD_RESET_CODE`); the app holds it
in a deliberately stricter short-lived, in-memory, server-side ticket
(`src/lib/server/first-access-ticket.ts`, 10 min, max 5 attempts) and it never reaches
the browser, a URL, or a log. Zitadel keeps only **one** outstanding reset code per
user — issuing a new one invalidates the previous (`CODE-woT0xc`) — so the ticket store
is indexed by user id and a new first access **supersedes** any earlier live ticket for
that user, rather than leaving it behind holding a code that can no longer be redeemed — the browser
only holds the opaque `first_access` httpOnly handle cookie. Because the ticket is
in-process, **run the login app single-instance (or with session affinity)** while this
feature is on; otherwise the second request can land on an instance that never saw the
ticket and the user sees an expired flow.

**Deploy windows interrupt first access.** Any restart — a deploy, a crash, an OOM, a
container reschedule — drops every in-flight ticket, and those users must re-enter their
ERP password and start over. Observed for real during testing (a dev hot reload did it).
Nothing is lost or corrupted and the reset code is not reused; the user simply sees
"this first access session has expired". Worth timing rollouts away from a migration
batch rather than fixing with a shared store today.

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
container build -f Dockerfile.dokploy -t im-login:latest .
```

### Docker (Dokploy build host)

```sh
docker build -f Dockerfile.dokploy -t im-login:latest .
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
  -f Dockerfile.dokploy -t im-login:latest .
```

Override the base path the same way:

```sh
container build \
  --build-arg NEXT_PUBLIC_BASE_PATH=/ui/v2/login \
  -f Dockerfile.dokploy -t im-login:latest .
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
| `AUTH_BACKEND_URL` | for Track B | Backend base URL, including the version prefix. Used for `/auth/resolve` (legacy identifier → canonical `loginName`) and `/auth/legacy-migrate` (first access via the legacy ERP password — see above). If unset, both are skipped: login still works with real `loginName`s and existing Zitadel passwords (fail-open), but provisioned users cannot complete a first access. |
| `AUTH_BACKEND_TOKEN` | for Track B | The backend's `RESOLVE_ALLOWED_SERVICE_ACCOUNT` shared secret (64 chars), sent as `x-zitadel-service-account` and checked by the `require_zitadel_service_account` guard on **both** endpoints. It is a **plain string compare, not a Zitadel identity check** — sending the `login-page` machine user's PAT (277 chars) instead makes the guard reject every call with a uniform `403` before any credential is looked at, which surfaces as "user not found" for a legacy identifier and "wrong password" for a first access. Bearer secret: server-side only, never logged. |
| `EMAIL_VERIFICATION` | no | `true`/`false`. Gates login on verifying a real unverified address, so it needs working SMTP. The undeliverable `invalido.troque` placeholder is exempt either way. |
| `OTEL_SDK_DISABLED` | no | `true` unless you run an OpenTelemetry collector. |
| `CSP_FETCH_ENABLED` | no | `false` to skip fetching iframe origins from Zitadel for CSP. |

The public domain is resolved at runtime from the `Host` / `X-Forwarded-Host` header
that Dokploy's reverse proxy sets — no domain env var is needed at runtime (only the
build-time `SERVER_ACTION_ALLOWED_ORIGINS` above).

### With Track B enabled, run the login app single-instance (or with session affinity)

First access is two requests: the one that verifies the ERP password and the one that
sets the new password. The reset code that authorizes the second must not reach the
browser, so it is held **in memory** in the app process (`src/lib/server/first-access-ticket.ts`)
and the browser gets only an opaque handle in the httpOnly `first_access` cookie. That
memory is per-process, so:

- **More than one replica without session affinity breaks first access.** If the second
  request lands on a replica that never saw the ticket, the user is told
  `Esta sessão de primeiro acesso expirou. Entre novamente para recomeçar.` even though
  nothing expired and their ERP password was correct. Scale to one instance, or configure
  sticky sessions on the proxy, for as long as `AUTH_BACKEND_URL` is set.
- **A restart or redeploy drops in-flight tickets.** That is the intended failure mode:
  the user retypes their ERP password and gets a fresh code.

The same per-process boundary exists *inside* the app: a Next.js route handler gets a
different module instance from the RSC/server-action layer, so a ticket written from a
route handler is invisible to the page that reads it. Keep every first-access read and
write in server actions and server components (measured: route handler saw the ticket
while the page saw none for the same cookie).

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

- **Dockerfile path:** `Dockerfile.dokploy`
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
