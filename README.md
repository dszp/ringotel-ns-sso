# ringotel-ns-sso

A public, standalone Cloudflare Worker that serves **Ringotel's SSO "authenticate" webhook** for any
NetSapiens + Ringotel operator. Point Ringotel's SSO integration at this Worker and it validates a login
against NetSapiens, resolves the caller's Ringotel record, and — per **per-domain policy** — either just
validates, or actively repairs Ringotel so the login can succeed cleanly.

## The problem it fixes

Ringotel's SSO delegates authentication to an external webhook: Ringotel `POST`s the user's credentials,
the webhook says yes/no, and Ringotel binds the app session to the Ringotel user **at that extension**.
Ringotel does not cleanly auto-create a working user on its own. If a login succeeds for an extension
whose Ringotel user is missing, inactive, or duplicated, Ringotel either fails the login or **strands the
record**: it stays active and billable but loses its SIP identity, and from then on the API refuses to
edit or delete it. Only Ringotel support can clear one.

The safe rule this Worker enforces: **a login may only succeed when a single, clean, active, SIP-linked
Ringotel user exists at that extension at the moment Ringotel binds.** It guarantees that by refusing
(the default), or by making it true first.

## What it can do, per domain

| | Behaviour |
|---|---|
| **validate** (default) | Allows a login only when a clean, active, SIP-linked user already exists. Never writes. |
| **heal** (opt-in) | Also reactivates an inactive record and removes duplicates at the extension before allowing. |
| **provision** (opt-in) | Also creates and activates a missing Ringotel user on first login, if the NetSapiens user passes an eligibility check (no system extensions, no shared mailboxes). |
| **repair** (opt-in) | For a login that needed no Ringotel change at all: recreates the *NetSapiens* softphone device if it has gone missing, **after** the response is sent, so it adds no latency. |

Each is opted into per domain by an allowlist, paired with a blocklist that always wins — so a
deployment can allow `*` and exclude a handful of domains rather than enumerating every permitted one.
A separate list refuses a domain's logins outright. **Fail-closed throughout**: any resolve, verify, or
timeout error denies (403) rather than guessing, and an unset allowlist means that mode is off. See
[SETUP.md](./SETUP.md).

A side benefit of provisioning: seats are created only when a user actually logs in, so an operator
never pays for a Ringotel seat that never signs in.

## Built on two published libraries

This Worker owns **composition and policy only**. Every NetSapiens/Ringotel primitive it sequences —
OAuth password-grant, org/branch resolution, user classification, eligibility, device/user writes — comes
from:

- [`@dszp/netsapiens-lib`](https://www.npmjs.com/package/@dszp/netsapiens-lib) — NetSapiens API v2
  client (read + write), OAuth token client, eligibility predicate.
- [`@dszp/ringotel-lib`](https://www.npmjs.com/package/@dszp/ringotel-lib) — Ringotel AdminAPI client
  (read + write), org/branch resolution, canonical-user resolution.

No provisioning logic is reinvented here — see [ARCHITECTURE.md](./ARCHITECTURE.md) for the pipeline and
the boundary between "the Worker" and "the libraries."

## Quickstart

**Start on Ringotel's side.** SSO is a PRO-package feature and the integration is configured by Ringotel
support, not self-serve — including the request shape and the response mapping that turns this Worker's
reply into a session. Nothing here can receive a request until that exists, so read
[SETUP.md § Before you start](./SETUP.md#before-you-start-ringotel-side-prerequisites) first.

Then: clone, `pnpm install`, copy `.dev.vars.example` to `.dev.vars` and fill in the secrets, set the
non-secret variables in `wrangler.jsonc`, and `pnpm dev` to run locally or `pnpm deploy` to ship it.
Point Ringotel's SSO webhook at the Worker with the Basic credential you configured — at `/authorize`, or
at whatever path your integration already uses, since `SSO_PATHS` accepts a list and can answer on both
at once. The full reference — every secret and variable, the two write-identity options, allow/block
semantics, and the proxy-to-direct migration path — is in **[SETUP.md](./SETUP.md)**.

## Pairs with `ns-portal-kit` — but neither needs the other

[`ns-portal-kit`](https://github.com/dszp/ns-portal-kit) is a separate deployable toolkit of add-ons for
the **NetSapiens Manager Portal**, also on Cloudflare Workers. Among other things it can activate and
deactivate a user's Ringotel app account from the portal UI. If you run both, they complement each other
naturally: the portal is where an administrator acts deliberately on a specific user, and this Worker is
what happens automatically when that user signs in.

**They are independent.** This Worker does not require the portal, reads none of its configuration, and
calls none of its endpoints — and the portal works fine with no SSO worker deployed. Deploy either one
alone.

The overlap is deliberately small and lives in the shared libraries rather than between the two
services: both use `resolveCanonicalUser` to decide which Ringotel record at an extension is the real
one, and `evaluateEligibility` to decide whether a NetSapiens user may be auto-activated. Keeping those
decisions in one place is what stops the two disagreeing about the same user — which is the only way a
portal and an SSO endpoint can quietly corrupt each other's work.

## Docs

- [SETUP.md](./SETUP.md) — configuration reference and deployment steps.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the request pipeline, the verdict × mode decision table, what
  each intervention does, and the reasoning behind the design's less obvious choices.
- [CHANGELOG.md](./CHANGELOG.md) — release notes.

## License

[MIT](./LICENSE) © 2026 David Szpunar.
