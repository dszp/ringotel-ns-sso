# Setup

Configuration reference and deployment steps. This document maps every setting onto the actual keys read
by [`src/config.ts`](./src/config.ts); see [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design rationale.

All values below are **fictional placeholders** — `example.com`, `demo.12345.service`,
`api.example.com`, `sso.example.com`. Every real value is operator-supplied config, never source.

## Contents

- [Before you start: Ringotel-side prerequisites](#before-you-start-ringotel-side-prerequisites)
- [Request contract](#request-contract)
- [Secrets vs. vars](#secrets-vs-vars)
- [Secrets](#secrets)
  - [Setting secrets](#setting-secrets)
- [What heal / provision / repair actually do](#what-heal--provision--repair-actually-do)
- [Allow/block pairs](#allowblock-pairs)
- [Vars (`wrangler.jsonc`)](#vars-wranglerjsonc)
- [Deploying](#deploying)
  - [Built-in per-account rate limit](#built-in-per-account-rate-limit)
- [Topology: direct, or behind a pass-through proxy](#topology-direct-or-behind-a-pass-through-proxy)
- [Health check](#health-check)
## Before you start: Ringotel-side prerequisites

**None of this is self-serve.** The SSO integration is configured on Ringotel's side by their support
team, so budget for a conversation with them before this Worker can receive a single request:

- **SSO is a PRO-package feature.** If the account isn't on it, there's nothing to configure.
- **A white-labelled app may also be required** to expose the SSO configuration. This is *believed* to be
  the case but is **not confirmed** — treat it as a question for support rather than a documented fact.
- **The request and response shapes are set per integration**, not fixed by a public spec: the endpoint
  URL, the auth method (Basic / Bearer / OAuth2), which fields the request body carries, and the
  `response_map` that turns this Worker's reply into a Ringotel session. Two deployments can legitimately
  see different shapes.
- **There is no published example of the exact shapes** at the time of writing — Ringotel's own docs
  describe the mechanism but not a worked request/response pair. That may improve; until it does, the
  authoritative answer for *your* integration is whatever support configured.

Practically: ask support to confirm what your integration sends, and what `response_map` it expects, and
match this Worker to it. The response fields this Worker returns are described under
"Request contract" below — if your `response_map` expects different names, that has to be reconciled on
Ringotel's side, because the Worker's reply is only useful if the map consumes the fields it emits.

## Request contract

`POST /authorize` (Basic auth) accepts a JSON body of `{ username, password[, domain] }`. `username` and
`password` are required, non-empty strings. **`domain` is optional** — confirmed live, Ringotel's actual
SSO webhook sends only `username`+`password`; its SSO service definition has a `$domain$` placeholder,
but it resolves to nothing at send time — so don't configure anything that requires it to be present.
**That reflects one integration's configuration, not a universal contract**: the request template is
set per integration by Ringotel, so yours may differ and may well populate `domain`. The Worker
handles either.

The NetSapiens domain instead lives inside `username`, as `<extension>@<short-domain>` (e.g.
`101@example`) — note that's the **short** label, without the territory suffix, so it will never equal
the full NetSapiens domain (`example.12345.service`) and must not be used as a substitute for it. The
Worker never derives identity from `username`'s domain portion either: the authoritative extension and
domain always come from the caller's own NS self-record (`GET /domains/~/users/~`), fetched after the NS
credential check succeeds. If a caller *does* supply `domain` in the body, it's cross-checked against that
self-record (mismatch → 403 `domain-mismatch`); if it's absent, that check is simply skipped
(`domainCheck: 'skipped-not-supplied'` in the log) and the self-derived domain governs everything
downstream, same as always.

This matters for `SSO_HEAL_DOMAINS`/`SSO_PROVISION_DOMAINS` below: they're matched against the
self-derived domain, which is always the **full** NetSapiens domain (with territory suffix) — configure
them with that full form, never the short label from `username`. `resolveOrgBranch`, eligibility, the
cross-tenant check, and `createUser`'s `domain` field all use this same full NetSapiens domain too.

**The success response's `domain` is different — it's the Ringotel org domain, not the NetSapiens one.**
`200 { extension, authname, domain }`: `domain` here is the value Ringotel's own SSO `response_map`
consumes to bind the session (`branch.domain ?? org.domain` in your Ringotel org/branch config — the short
Ringotel-side domain, e.g. `demo`), never the full NetSapiens domain used everywhere above. If neither the
matched branch nor its org has a Ringotel domain configured, the Worker falls back to the NetSapiens domain
so the field is never sent empty (logged as `rtDomainFallback: true`).

## Secrets vs. vars

- **Secrets** hold credentials. Set them with `wrangler secret put` (never written to `wrangler.jsonc`,
  never committed).
- **Vars** hold non-secret policy/config. Set them under `vars` in [`wrangler.jsonc`](./wrangler.jsonc).

For local development, copy [`.dev.vars.example`](./.dev.vars.example) to `.dev.vars` (gitignored) and
fill in the minimal secret set; `wrangler dev` reads it automatically.

## Secrets

| Key | Required | Purpose |
|---|---|---|
| `SSO_BASIC_USER` | **yes** | The Basic-auth username Ringotel (or a proxy in front of this Worker) must present on every request. |
| `SSO_BASIC_PASSWORD` | **yes** | The Basic-auth password paired with `SSO_BASIC_USER`. |
| `NS_OAUTH_CLIENT_ID` | **yes** | NetSapiens OAuth **master key** client id. Always required — end-user login verification is an OAuth password-grant signed with this key. |
| `NS_OAUTH_CLIENT_SECRET` | **yes** | NetSapiens OAuth master key client secret. |
| `NS_ADMIN_USER` + `NS_ADMIN_PASS` | one of these two, or `NS_API_KEY` | **Write identity, option A** — a NetSapiens user (reseller/admin-capable) the Worker OAuths as (via the master key) to mint a token for device/user writes during heal/provision. |
| `NS_API_KEY` | one of these two, or `NS_ADMIN_USER`+`NS_ADMIN_PASS` | **Write identity, option B** — a static NetSapiens API bearer token, used directly for device/user writes. |
| `RINGOTEL_API_KEY` | **yes** | Ringotel AdminAPI key. Used for every read; also for writes when `heal` or `provision` is enabled for a domain. |

**Write identity is always required**, even in `validate`-only deployments — `parseConfig` throws if
neither option is set, because the Worker cannot know in advance that every domain it will ever serve
stays validate-only. Set exactly one of the two options; if both are set, `NS_ADMIN_USER`/`NS_ADMIN_PASS`
wins.

**OM-only-for-single-domain caveat.** An Office Manager (OM) user is scoped to one NetSapiens domain, so
`NS_ADMIN_USER`/`NS_ADMIN_PASS` may point at an OM account **only** when this Worker deployment serves a
single domain — the domain the OM belongs to. A Worker serving multiple domains (via `SSO_HEAL_DOMAINS` /
`SSO_PROVISION_DOMAINS` covering more than one domain, or `*`) needs a reseller/admin-scoped identity (or
`NS_API_KEY` scoped accordingly), or writes to other domains will fail.

### Setting secrets

Pipe each secret in from your own secret manager — never type it on the command line (shell history) and
never let it echo to a terminal or log:

```bash
# `read-secret` = whatever your secret manager exposes (a vault CLI, `pass`, an env file, etc.).
# The point is to PIPE the value in — never pass it as an argument and never let it echo.
read-secret SSO_BASIC_USER        | wrangler secret put SSO_BASIC_USER
read-secret SSO_BASIC_PASSWORD    | wrangler secret put SSO_BASIC_PASSWORD
read-secret NS_OAUTH_CLIENT_ID    | wrangler secret put NS_OAUTH_CLIENT_ID
read-secret NS_OAUTH_CLIENT_SECRET| wrangler secret put NS_OAUTH_CLIENT_SECRET

# write identity — pick ONE of the two below
read-secret NS_ADMIN_USER | wrangler secret put NS_ADMIN_USER
read-secret NS_ADMIN_PASS | wrangler secret put NS_ADMIN_PASS
# — or —
read-secret NS_API_KEY    | wrangler secret put NS_API_KEY

read-secret RINGOTEL_API_KEY | wrangler secret put RINGOTEL_API_KEY
```

`wrangler secret put <NAME>` also accepts a value typed interactively (no argv, no echo) if you'd rather
not use a secret manager — run it bare and paste the value at the prompt.

## What heal / provision / repair actually do

Short version — **provision** creates a Ringotel user that doesn't exist, **heal** fixes one that exists
but is deactivated or duplicated, and **repair** recreates a *NetSapiens* device that went missing under
a Ringotel user that was already fine. Provision and heal write to Ringotel during the request; repair
writes to NetSapiens after the response. Only provision can increase what you're billed for, and it is
the only one gated by eligibility. Full detail, including the write sequences and why heal's ordering
matters, is in [`ARCHITECTURE.md`](./ARCHITECTURE.md#the-three-interventions-provision-heal-repair).

## Allow/block pairs

Every write mode is an **allowlist narrowed by a blocklist, and the block always wins**. The intended
shape for a multi-domain deployment is a broad allowlist — usually `*` — plus a short blocklist naming
the domains that must not be touched, rather than enumerating every permitted domain and keeping that
list in sync as customers are added.

**Blocking a specific extension everywhere but one domain** is the other common shape, and it needs both
settings: put the extension in `SSO_BLOCK_EXTS`, then exempt the one domain with a `remove` entry in
`SSO_BLOCK_EXTS_BY_DOMAIN`. Worth understanding why this is separate from the soft `RINGOTEL_EXCLUDE_EXTS`
list: a soft exclusion only gates *auto-creation*, so a heal or a repair would still create the device on
the reasoning that an existing record implies somebody deliberately made one. `SSO_BLOCK_EXTS` is the
harder statement — no device here, ever — and so it gates all three write paths.

**Every domain blocklist accepts `*`**, meaning "block everywhere". For provision and repair that is simply the
inverse of an empty allowlist. For **heal** it is not redundant, and is the one genuinely useful case:
because provision mode also heals, `SSO_HEAL_BLOCK_DOMAINS="*"` with a broad provision allowlist gives
*create missing users, never modify existing ones* — a posture you cannot otherwise express.

An empty blocklist blocks nothing; an empty allowlist permits nothing. Blocking is per-mode, so a domain
can be excluded from provisioning while still being healed, and `SSO_BLOCK_DOMAINS` sits above all of it
to refuse the login entirely.

**Consider blocking your infrastructure domains.** Most NetSapiens fleets have one or more domains that
exist to hold DIDs, routing, or administrative accounts rather than real people — a DID-holding domain, a
reseller's own internal domain, a template or staging domain. Nobody in them should be signing into the
app, and with a broad `SSO_PROVISION_DOMAINS` (e.g. `*`) an unexpected login there would create a
**billable** Ringotel user for something that isn't a person. Listing them in `SSO_BLOCK_DOMAINS` refuses
those logins outright:

```jsonc
"SSO_PROVISION_DOMAINS": "*",                        // pay-on-first-login across the fleet
"SSO_BLOCK_DOMAINS": "dids.12345.service,internal.12345.service"
```

Eligibility already hard-blocks system/service users and non-3-4-digit extensions, and a domain with no
Ringotel org bound to it can't provision at all — so this is defence in depth rather than the only
guard. But it is the one that states the intent explicitly, and it costs nothing.

If instead you want a domain to keep authenticating normally while never being written to, leave it out
of `SSO_BLOCK_DOMAINS` and list it in the three per-mode blocklists — `SSO_BLOCK_DOMAINS` refuses the
login itself, including for perfectly healthy existing users.

**Not everything is per-domain.** The allow/block pairs cover the three write modes and the login gate.
Other policy settings — `SSO_SEND_ACTIVATION_EMAIL`, `SSO_REQUIRE_EMAIL`, and the eligibility exclusions
apart from `RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN` — apply to the **whole deployment**. A deployment needing
genuinely different policy per customer has to run more than one Worker, at least for now.

## Vars (`wrangler.jsonc`)

> **Which "domain"?** Every domain-valued setting below means the **full NetSapiens domain, with its
> territory suffix** — e.g. `example.12345.service`. Not the short label a user types in `username`
> (`101@example`), and **not** the Ringotel org domain. The two are frequently different, and the
> Worker deals with both: it matches config against the NetSapiens domain taken from the user's own
> self-record, while the Ringotel org domain appears only in the success response (see "Request
> contract"). The single exception is `SSO_DOMAIN_MAP`, whose *keys* are the NetSapiens domain's first
> DNS label and whose *values* are Ringotel org keys — it exists precisely to bridge the two.


| Key | Default | Purpose |
|---|---|---|
| `NS_SERVER` | *(required, no default)* | NetSapiens API host, e.g. `api.example.com`. Used for both v2 reads and device writes. |
| `NS_OAUTH_SERVER` | blank ⇒ falls back to `NS_SERVER` | OAuth host, if it differs from `NS_SERVER` on your platform. |
| `DEVICE_SUFFIX` | `r` | Appended to the extension to form the softphone device id and SIP `authname`, e.g. extension `101` → device/authname `101r`. |
| `SSO_HEAL_DOMAINS` | empty (off) | **Full** NetSapiens domains (with territory suffix, e.g. `example.12345.service` — not the short label from `username`) where `heal` mode is enabled. `*` = all domains, or a CSV list (`a.12345.service,b.67890.service`, case-insensitive). **Empty ⇒ heal is off everywhere.** |
| `SSO_PROVISION_DOMAINS` | empty (off) | **Full NetSapiens domains**, same `*` / CSV / empty semantics as above, for `provision` mode. **Empty ⇒ provisioning is off everywhere.** Provision beats heal beats validate when a domain is listed in both. |
| `SSO_REPAIR_DOMAINS` | empty (off) | **Full NetSapiens domains**, same `*` / CSV / empty semantics as above. Domains where an **already-approved** login may repair a missing softphone device *after* the response has been sent (see ARCHITECTURE.md → "Post-response repair"). **Empty ⇒ repair is off everywhere.** Independent of heal/provision: it is the only mode that writes outside the request. |
| `SSO_PATHS` | empty (`/authorize`) | Comma-separated request paths this Worker answers `POST` on. Ringotel's SSO service definition holds whatever endpoint URL was configured for **your** integration — often not `/authorize` (e.g. a proxy's `/webhook/<id>`), and changing it is a vendor-side support request. Accepting a **list** lets one deploy answer on the old and new paths at once, so moving traffic (e.g. retiring a proxy in front of this Worker) is a DNS change with an instant rollback rather than a flag day. Leading slashes and surrounding whitespace are normalised; a blank value falls back to `/authorize` rather than answering on nothing. `GET /health` is served regardless. |
| `SSO_SEND_ACTIVATION_EMAIL` | empty (**off**) | Whether an SSO-initiated activation sends Ringotel's credentials email. **Default: off.** A user who arrived via SSO authenticated with their NetSapiens credentials and is already inside the app, so the emailed app password is noise. Truthy (`1`/`true`/`yes`/`on`) turns it on — useful where users also sign in directly, or where the emailed QR code is the intended onboarding path. Drives Ringotel's `noemail` flag (inverted): the credentials email fires when a write carries **both** `status: 1` and an `email` field, which every heal/provision write here does, since it also syncs the NetSapiens name/email into the directory entry. |
| `SSO_REQUIRE_EMAIL` | `auto` | Whether auto-provisioning requires the NetSapiens user to have an email address: `auto` \| `always` \| `never`. The rule exists because activation traditionally emails the credentials, so `auto` ties it to its own reason — an address is required exactly when `SSO_SEND_ACTIVATION_EMAIL` means one will be used. With the email suppressed (the default), a user without an address provisions normally. `always` keeps the requirement regardless, which is useful where a missing address is a deliberate marker for staff who should not get an app login. `never` drops it. **Only affects creation** — an existing user signs in, and is healed if inactive, either way. An unrecognised value is a startup error rather than a guess. **Deployment-wide only — there is currently no per-domain override for this setting**, unlike the heal/provision/repair allow/block pairs. If you need "no email = no app login" for some domains but not others, that isn't expressible yet. |
| `SSO_BLOCK_DOMAINS` | empty (nothing blocked) | **Full NetSapiens domains** refused **outright** — a login is denied even though the NetSapiens credentials are valid, before mode selection or any Ringotel call. Same full-domain / `*` / CSV semantics as the allowlists. `*` is a kill switch for the whole deployment. Note this is evaluated *after* the NetSapiens credential check, because the domain comes from the user's own self-record and is never taken from the request. |
| `SSO_HEAL_BLOCK_DOMAINS` | empty | **Full NetSapiens domains**, or `*` for all. Refuses `heal` for these even when `SSO_HEAL_DOMAINS` would allow it. `*` here is **not** the same as emptying `SSO_HEAL_DOMAINS`: provision mode heals too, so `SSO_HEAL_BLOCK_DOMAINS="*"` alongside a broad provision allowlist means *create missing users, but never modify existing ones* — reactivation and sibling dedup are both refused. |
| `SSO_PROVISION_BLOCK_DOMAINS` | empty | **Full NetSapiens domains.** Refuses `provision` for these even when `SSO_PROVISION_DOMAINS` would allow it. `*` blocks provisioning everywhere (equivalent to an empty `SSO_PROVISION_DOMAINS`). A blocked domain falls back to the next weaker mode (so blocking provisioning on a `*`-provision deployment leaves `heal`, if heal still permits it). |
| `SSO_REPAIR_BLOCK_DOMAINS` | empty | **Full NetSapiens domains**, or `*` for all. Refuses post-response repair for these even when `SSO_REPAIR_DOMAINS` would allow it. `*` disables repair everywhere (equivalent to an empty `SSO_REPAIR_DOMAINS`). |
| `SSO_BLOCK_EXTS` | empty | Extensions that must **never gain a softphone device**, on any domain. CSV; a trailing `*` is a prefix wildcard (`90*` covers 900, 901, 9012…; a bare `*` blocks every extension everywhere). Blocks every device-creating path — `provision`, `heal`, **and** post-response `repair` — but deliberately does **not** refuse the login, so an extension that already has a working record keeps working. Distinct from `RINGOTEL_EXCLUDE_EXTS`, which is a *soft* rule gating auto-creation only and still permits heal and repair. |
| `SSO_BLOCK_EXTS_BY_DOMAIN` | empty | JSON keyed by **full NetSapiens domain**, applying `add` then `remove` over `SSO_BLOCK_EXTS` — e.g. `{"one.12345.service": {"remove": ["900"]}}` to block an extension everywhere *except* one domain. Malformed JSON is a startup error, not a silent no-op. `remove` is matched with the **same wildcard semantics** as the block list, so a global `90*` can be exempted on one domain with `remove: ["900"]`. An unknown key, or a value listed in both `add` and `remove`, is a startup error rather than a silent no-op. |
| `SSO_DOMAIN_MAP` | empty | Optional JSON object mapping a NetSapiens domain's first DNS label to a Ringotel org key override, e.g. `{"legacy":"acme"}`. Only needed when the default (first-label-as-org-key) match doesn't hold. |
| `RINGOTEL_EXCLUDE_NAMES` | *(see note)* | CSV of name substrings that soft-exclude a NetSapiens user from auto-provision (case-insensitive), e.g. `SHARED,SHARED VOICEMAIL,FAX`. |
| `RINGOTEL_EXCLUDE_EXTS` | empty | CSV of specific extensions to soft-exclude from auto-provision. |
| `RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN` | empty | Optional JSON object keyed by **full NetSapiens domain**, per-domain extension overrides: `{"demo.12345.service": {"add": ["100"], "remove": ["200"]}}`. |

**`RINGOTEL_EXCLUDE_NAMES` default gotcha:** the built-in default (`SHARED`, `SHARED VOICEMAIL`, `FAX`)
only applies when the key is **absent from `env` entirely**. Cloudflare vars declared in `wrangler.jsonc`
are always present as strings once listed — so the template ships `"RINGOTEL_EXCLUDE_NAMES": ""`, which
is an *explicit empty list*, not "use the default." If you want the built-in defaults, either delete the
key from `vars` or set it explicitly to `"SHARED,SHARED VOICEMAIL,FAX"`.

Eligibility only gates `heal`/`provision` creation decisions (verdict `none` on a `provision` domain) and
reactivation is otherwise ungated by eligibility — see [ARCHITECTURE.md](./ARCHITECTURE.md) for the full
verdict × mode table.



## Deploying

> **Deployment is a workstation action, not a GitHub Action.** This repo intentionally ships no deploy
> workflow. The tracked `wrangler.jsonc` is a neutral template — empty `NS_SERVER`, empty allowlists —
> so a CI job deploying it would overwrite a working deployment with a configuration that fails closed
> and refuses every login. Keep your real values in a gitignored config (e.g. `wrangler.local.jsonc`,
> deployed with `wrangler deploy -c wrangler.local.jsonc`) or in secrets, and deploy deliberately.

```bash
pnpm install
pnpm typecheck && pnpm test   # offline; zero setup required
# set secrets (see above), fill in vars in wrangler.jsonc, then:
pnpm deploy
```

### Built-in per-account rate limit

> ⚠️ **Verify this actually enforces before you rely on it.** On at least one Cloudflare account the
> binding was present and `.limit()` returned `{ success: true }` for *every* call — including 18
> concurrent requests on the same key — so **nothing was ever limited and no `429` was ever returned**.
> The code below is correct and fails open by design, which means a non-enforcing binding is silent:
> you get no error, no warning, and no rate limiting. Confirm it works on your account (hammer one key
> and look for a `429`) before counting it as a control. Rate limiting may need to be enabled for the
> account or plan first.


`/authorize` verifies the caller's **NetSapiens** credentials on every request, so an unthrottled endpoint
is a password-brute-force surface (anyone holding the shared Basic secret can try end-user passwords at
edge scale). The Worker has a rate limit for this built in — you only need to wire up the binding.

**Why per-account, not per-IP.** The caller here is Ringotel's own infrastructure (or a proxy sitting
in front of it), so every request — across every domain and every end user — arrives from a small, shared
set of source IPs. A per-IP rule would throttle all of your users collectively the moment traffic gets
busy. Instead the limiter is keyed on the **account being authenticated** — lowercased `domain:username`
(`domain` half is empty when the request didn't supply one, which is the common case; never logged, only
`domain` and the deny reason are) — so it scales to any number of domains/users while still capping how
fast one attacker can grind through passwords for a single account.

**Wiring it up.** Add a [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
binding named `SSO_RATE_LIMITER` under `ratelimits` in your `wrangler.jsonc` (or `wrangler.local.jsonc`):

```jsonc
"ratelimits": [{ "name": "SSO_RATE_LIMITER", "namespace_id": "2001", "simple": { "limit": 10, "period": 60 } }]
```

- `namespace_id` just needs to be unique per binding within your account — any small integer works.
- `limit`/`period` are requests per `period` seconds, per account key. The default above (10 per 60s) is
  generous for normal SSO logins (occasional retries, a user fat-fingering a password a couple of times)
  while still bounding a brute-force attempt. Tune both to taste — e.g. loosen `limit` if legitimate
  clients regularly retry more than that, or tighten `period` for a faster-decaying window.
- A request over the limit gets HTTP `429` and a structured log line `{"outcome":"deny","reason":"rate-limited","domain":...}` — watch for repeated hits from one domain the same way you'd watch for
  repeated `bad-credentials` denials.

**Fails open by design.** `SSO_RATE_LIMITER` is an *optional* binding — a fork or deployment that never
configures it (no `ratelimits` entry in `wrangler.jsonc`) skips the check entirely and authenticates
exactly as before. Rate limiting is an abuse control layered on top of auth, not part of the auth decision
itself, so a missing or misbehaving binding (the `.limit()` call throwing) is logged and treated as
"allow," never as a reason to block or 500 a legitimate request.

## Topology: direct, or behind a pass-through proxy

The Worker implements only the fixed Ringotel wire contract (`POST` to a configured path, Basic auth,
`{username, password[, domain]}` JSON body in, `{extension, authname, domain}` / 403 out — where the
response `domain` is the **Ringotel** org domain, not the NetSapiens one; see "Request contract" above),
so it is indifferent to who calls it.

1. **Direct (recommended).** Point Ringotel's SSO webhook configuration at your Worker host, with the
   same Basic credential configured on the Ringotel side.

   **If Ringotel is already configured to post to some other path**, you do not need a proxy and you do
   not need to ask Ringotel to change the URL: list that path in [`SSO_PATHS`](#vars-wranglerjsonc).
   Because it accepts a **list**, one deploy can answer on both the existing path and `/authorize` at
   the same time — so moving traffic onto the Worker becomes a DNS change with an instant rollback,
   rather than a coordinated cutover.

2. **Behind a pass-through proxy.** If something already terminates the webhook and you'd rather not
   move it yet, make it a thin relay. It must:
   - Forward the request body unchanged.
   - **Forward the `Authorization` header verbatim** (the Basic credential Ringotel sent) — do not
     substitute or drop it; the Worker validates it itself.
   - Target your Worker host on a path listed in `SSO_PATHS`.
   - **Relay the Worker's status code and body straight back to Ringotel** — don't normalise a 403 into
     a 200, and don't drop the JSON body on success. Ringotel treats any non-2xx as "auth failed", so a
     faithful relay is what makes the proxy transparent.



## Health check

`GET /health` returns `200 ok` unauthenticated — safe for uptime monitoring; it does not exercise config
or credentials.
