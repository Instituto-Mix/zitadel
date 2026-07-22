# Authorization model (decision record)

Decided 2026-07-22 (Eder). Governs how Zitadel roles are used across all
Instituto Mix apps that authenticate against this instance.

## Where authorization lives

- **Zitadel = identity + the door.** Who you are, and whether you may enter an
  app at all.
- **Backend API (DBMix) = scope truth.** *Where* your access applies — which
  franchise(s), region(s), franchisor-wide — is resolved at runtime by calling
  the backend with the authenticated `user_id`. Affiliations are many-to-many
  and fluid (an employee can become a franchisee); they are **never** mirrored
  into Zitadel.

## Role vocabulary (Zitadel project roles)

Two axes, defined per project, exact case matters (role keys are
case-sensitive — the provisioner must match byte-for-byte):

- **User types:** `Franchisee`, `Employee`, `Student` — stable identity facts.
  These are the **gate roles**: projects enable *"Only authorized users can
  authenticate"*, so a user without a grant on the project is refused a token
  at login.
- **Levels:** `Franchise`, `Region`, `Franchisor` — coarse access tiers.

## The hard rule for levels

**Level claims may gate *visibility*, never *data*.**

A level role in the token is incomplete — it says "has regional access
somewhere", not *which* region. Apps may use it to decide whether to render a
menu/section at all. Any scoped read or write (which region's data, which
franchise's students) MUST go to the backend API with the user's `user_id` and
be authorized there. Treating a level claim as data authorization is a
cross-scope leak waiting to happen.

## Grants

- One user grant per user per project; `roleKeys` = derived state from DBMix
  user types (provisioner converges on every sync; update, don't append).
- A role held **at any org counts** — access is not gated to a single org.
  Multi-org reach comes from project grants; the per-org scoping of what the
  user may *see* stays in the backend.
- Grant only the roles a project actually uses. The door-gate fires on *any*
  role, so granting the full vocabulary everywhere would let, e.g., a
  Student-only user into staff apps.

## App checklist (for every new app/project)

1. Create the project; define only the roles it consumes.
2. Enable **"Return user roles during authentication"** and **"Only authorized
   users can authenticate"**.
3. Read type/level roles from token claims for UI shell decisions only.
4. Resolve all scoped access via the backend API (`user_id` → affiliations).
5. Provisioner: add the project ID to the grant-sync configuration.

## WebAuthn reminder (unrelated to roles, but adjacent)

U2F/passkey factors must be enrolled through the login UI on
`entrar.institutomix.com.br` (RP ID `institutomix.com.br`) — never via the
Console — or they bind to the wrong RP ID and fail at login.
