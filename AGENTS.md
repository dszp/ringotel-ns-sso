# AGENTS.md — deploying this Worker

For a coding agent asked to **deploy** `ringotel-ns-sso` for an operator. It carries the order of
operations and the decisions you must bring to a human; it deliberately does **not** restate what each
setting means — that is [SETUP.md](./SETUP.md), linked at each step. One fact, one place.

If you are changing the code rather than deploying it, this file is not for you: read
[ARCHITECTURE.md](./ARCHITECTURE.md) and run `pnpm test`.

---

## STOP — this does not start with `pnpm install`

**The SSO integration is configured by Ringotel's support team, not in this repo and not self-serve.**
Until that exists, this Worker cannot receive a single request, and every command below will appear to
succeed while nothing works. You cannot do this step: it is a vendor conversation. Hand it to the operator
before touching the code.

What they need to ask Ringotel support for, and hand back to you:

1. **Is the account on the PRO package?** SSO is a PRO feature; without it there is nothing to configure.
   PRO can be enabled **per organization**, but it generally carries an **additional per-user cost** —
   clarify that with Ringotel before anyone incurs charges. (A white-labelled app may also be required —
   *believed*, not confirmed. Ask; do not assert it.)
2. **The endpoint URL is yours to choose, not theirs to reveal.** You tell Ringotel the URL you want the
   requests sent to. `/authorize` is this Worker's default and works fine — but it still has to be given
   to them, and a *later* change is another support request, so pick it before they configure anything.
3. **The auth method and credential.** This Worker implements **Basic**; Ringotel supports several
   varieties. You generate a username and password, give them to Ringotel, and they present the same pair
   back on every SSO request.
4. **The request template and the `response_map`.** The template is JSON and holds the Basic credential,
   this Worker's endpoint URL, and the fields to transmit. `username` and `password` are required, and
   must correspond to the **NetSapiens login username and password** of the user signing in. `domain`, if
   populated, carries the **Ringotel organization name** — which the user types *first*, before their
   login name and password. It may happen to match the NetSapiens domain (full or short), but only by
   convention; nothing requires it, so never treat it as the NetSapiens domain. The `response_map` is what
   turns this Worker's reply into a session.

Details and the reasoning: [SETUP.md § Before you start](./SETUP.md#before-you-start-ringotel-side-prerequisites)
and [§ Request contract](./SETUP.md#request-contract). If the `response_map` expects field names other
than `extension` / `authname` / `domain`, that is reconciled on **Ringotel's** side — this Worker's reply
is only useful if the map consumes what it emits.

## Ask the operator these five — do not choose them

Each answer becomes configuration. Every one of them has a default that is deliberately *off*, so a wrong
guess here is not a small mistake.

| Ask | Why you must not decide it |
|---|---|
| Which domains may **heal**, **provision**, **repair**? | These write to Ringotel and to the phone system. **Provisioning creates billable Ringotel seats, and creates NetSapiens devices for an extension, which may also affect billing.** Off unless named. |
| Send Ringotel's activation email? | An SSO user is already inside the app and never needs the emailed password — but a deployment where people *also* sign in directly does need it. |
| Must a user have an email address to be auto-provisioned? | Some operators use "no address on file" as a deliberate marker for staff who get no app account. |
| Which extensions and which domains are blocked outright? | Shared, park, fax and infrastructure extensions should never get an app account, and a DID-holding or internal domain should not be signing in at all. |
| Is there an **existing** integration, and if so which path does it already POST to? | For a new integration the path is yours to choose (step 2 above). For one that already exists, it is whatever was configured — changing it is a support request, whereas adding that path to `SSO_PATHS` is not. Guessing produces a 404 that looks like a broken deploy. |

Names, formats and defaults for the settings these map onto:
[SETUP.md § Vars](./SETUP.md#vars-wranglerjsonc) and [§ Allow/block pairs](./SETUP.md#allowblock-pairs).
What the three write modes actually do:
[§ What heal / provision / repair actually do](./SETUP.md#what-heal--provision--repair-actually-do).

## Never

- **Never set a heal / provision / repair list to `*` unless the operator asked for that in those words.**
  Provisioning on first login creates **billable** Ringotel seats, on every domain at once — and it creates
  a **NetSapiens device** for the extension, which may affect NetSapiens billing too. Empty (off) is the
  default precisely so nothing happens by accident.
- **Never invent a NetSapiens domain.** Every domain-valued setting takes the domain **exactly as that
  NetSapiens server stores it** — usually the full form (`example.12345.service`), and it is what the
  user's own record reports, not what anyone types. Do not substitute the short label from a `username`
  (`101@example`) and do not substitute the Ringotel organization name. (A bare label *can* legitimately be
  the whole domain, depending on the reseller's territory configuration on that server — so the rule is
  "use the stored value", not "always append a suffix".) The three look alike, and the wrong one silently
  disables a rule instead of erroring.
- **Never put a credential in `vars`.** `wrangler.jsonc` vars are readable in the Cloudflare dashboard.
  Credentials go in `wrangler secret put` — see [§ Secrets vs. vars](./SETUP.md#secrets-vs-vars).
- **Never pass a secret as a command argument.** Pipe it in, so it stays out of shell history and terminal
  output: [§ Setting secrets](./SETUP.md#setting-secrets).
- **Never `wrangler deploy` the tracked `wrangler.jsonc`.** It is a neutral template with an empty
  `NS_SERVER` and empty allowlists; deploying it replaces a working deployment with one that fails closed
  and refuses every login. Real values belong in a gitignored copy (below).
- **Never add a deploy workflow.** This repo ships none on purpose — for the reason above, a CI job would
  deploy the template. Deployment is a deliberate workstation action.
- **Never commit `.dev.vars`, `wrangler.local.jsonc`, or any file holding real values.** Both are
  gitignored already; keep it that way.
- **Never make up a config value to get past an error.** A missing answer is a question for the operator.
  This Worker fails closed by design: a config it does not understand refuses logins rather than guessing,
  and an invented value converts a loud startup error into a silent misconfiguration.

## The sequence

Run these in order. Do not reorder them — the offline checks exist to prove the tree before any
credential is in play, and secrets must exist before the first deploy or it goes live failing closed.

1. **Install and prove the tree, offline.**
   ```bash
   pnpm install
   pnpm typecheck && pnpm test
   ```
   Expect: typecheck silent, all tests passing, no credentials and no network required. If this fails,
   stop — nothing downstream is diagnosable.

2. **Create the real config as a gitignored copy of the template.**
   ```bash
   cp wrangler.jsonc wrangler.local.jsonc      # gitignored
   ```
   Fill in `NS_SERVER` and the answers from the five questions.
   Reference: [§ Vars](./SETUP.md#vars-wranglerjsonc). Leave anything you were not told about at its
   default; every default is the safe direction.

3. **Set the secrets, piped.** The required set and both write-identity options are in
   [§ Secrets](./SETUP.md#secrets); the piping pattern is in
   [§ Setting secrets](./SETUP.md#setting-secrets). A write identity is required even for a
   validate-only deployment.

4. **Deploy deliberately.**
   ```bash
   wrangler deploy -c wrangler.local.jsonc
   ```
   `pnpm deploy` deploys `wrangler.jsonc` — correct only if that file genuinely holds this deployment's
   config, which for a clone of this repo it does not.

5. **Tell the operator what to give Ringotel:** the Worker's URL on a path listed in `SSO_PATHS`, and the
   Basic credential. If Ringotel already posts somewhere else, that path can simply be added to
   `SSO_PATHS` rather than changed on their side — one deploy can answer on both at once, which turns a
   cutover into a DNS change. See [§ Topology](./SETUP.md#topology-direct-or-behind-a-pass-through-proxy).

## Verify, in this order

Each rung proves something the previous one did not. A wrong step here is silent, which is why the order
matters.

1. **`GET /health`** → `200 ok`. Proves the Worker is deployed and routing. It intentionally exercises no
   config and no credential, so a 200 here proves nothing else.
2. **`POST` to your configured path with no `Authorization` header** → `401`. Proves the Basic gate is
   live. A `403` instead means the configuration failed to parse — the Worker fails closed before reaching
   auth. A `404` means the path is not in `SSO_PATHS`.
3. **A real login, by a real user, through the app.** No synthetic request can exercise the NetSapiens
   credential check, the identity read, or Ringotel's own binding.
4. **Read the structured log line for that login** and confirm `outcome`, `verdict`, `action` and
   `domainCheck`. **This is the step people skip, and the only one that proves the integration** rather
   than proving the Worker booted. Field meanings:
   [§ What ends up in the logs](./SETUP.md#what-ends-up-in-the-logs).

Report the log line's fields back to the operator. `outcome: allow` with an unexpected `action` (a write
where they wanted validation only) is a configuration error that looks like success.

## Two things that will waste your time

- **The Cloudflare rate-limit binding may be bound and silently never limit.** Confirmed on at least one
  account: `.limit()` returned `{ success: true }` for every call, including a burst well over the
  configured limit, so nothing was ever throttled and no `429` was ever returned. It fails open by design,
  so a non-enforcing binding produces no error and no warning. If the operator is counting on it, prove it
  — hammer one key and look for a `429`. See
  [§ Built-in per-account rate limit](./SETUP.md#built-in-per-account-rate-limit).
- **Workers Logs retention is 7 days.** Verification step 4 has a deadline, and "it worked last week, show
  me" is not answerable. If the operator wants durable history, that is an export they must set up
  separately.

## If it fails

The failure is almost always one of: the vendor integration does not exist yet (STOP box), the path is not
in `SSO_PATHS` (404), the config did not parse (403 on every request, including one with valid Basic auth),
or a domain-valued setting does not match what the server actually stores — typically a short label written
where the full domain is stored, or the Ringotel organization name written in place of either. Check the log
line's `reason` first — it names the refusal — then the setting behind it in
[SETUP.md](./SETUP.md#vars-wranglerjsonc). Do not work around a refusal by widening an allowlist.
