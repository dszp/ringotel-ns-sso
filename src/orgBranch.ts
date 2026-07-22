import { resolveOrg, type MappingConfig, type Rec } from '@dszp/ringotel-lib';

export interface OrgBranch { orgid: string; branchid: string; rtDomain: string }

export interface OrgBranchReader {
  getOrganizations(): Promise<Rec[]>;
  getBranches(orgid: string): Promise<Rec[]>;
}

const str = (v: unknown): string => (v == null ? '' : String(v)).trim();

/**
 * Resolve an NS domain to a Ringotel { orgid, branchid, rtDomain }. Two steps: pick the org via the
 * mapping engine (first-label default, or override rules), then CONFIRM authoritatively that one of
 * that org's branches carries `address === <full NS domain>` — the same key Ringotel binds an SSO
 * login by. Returns null if either step fails (caller fails closed → 403).
 *
 * `rtDomain` is the Ringotel-side short domain — `branch.domain ?? org.domain`, coerced to a trimmed
 * string. If neither carries one, `rtDomain` is `''`; that alone does NOT fail resolution (the caller
 * decides the fallback — see authorize.ts).
 */
export async function resolveOrgBranch(read: OrgBranchReader, domain: string, mapping: MappingConfig): Promise<OrgBranch | null> {
  const orgs = await read.getOrganizations();
  // (M5) Lowercase the first label so it matches the lowercased SSO_DOMAIN_MAP rule keys parsed in
  // config.ts, regardless of the case NS presents the domain in.
  const firstLabel = (domain.split('.')[0] ?? domain).toLowerCase();
  const org = resolveOrg(firstLabel, orgs, mapping);
  if (!org?.id) return null;
  const orgid = String(org.id);
  const branches = await read.getBranches(orgid);
  const branch = branches.find((b) => typeof b.address === 'string' && b.address.toLowerCase() === domain.toLowerCase());
  if (!branch?.id) return null;
  const rtDomain = str(branch.domain) || str(org.domain);
  return { orgid, branchid: String(branch.id), rtDomain };
}

/** Outcome of the REVERSE lookup (Ringotel org domain → NetSapiens domain). */
export type RtDomainLookup =
  | { ok: true; nsDomain: string }
  | { ok: false; reason: 'not-found' | 'ambiguous' };

/**
 * Resolve a RINGOTEL org domain (what the app's sign-in screen asks for, e.g. `acmevoice`) back to the
 * NetSapiens domain that Ringotel binds it to — the `address` on the matching branch. This is the
 * inverse of `resolveOrgBranch`, and exists so a user can type just their extension: Ringotel knows its
 * own org domain but not the NetSapiens one, and an extension alone cannot identify a tenant.
 *
 * It necessarily runs BEFORE any credential check (its answer is what the credentials are checked
 * against), so it is deliberately narrow: two reads, no writes, and a caller-supplied value is used only
 * to LOOK SOMETHING UP. It never becomes identity — after authentication the NS self-record remains the
 * sole source of extension and domain, exactly as before.
 *
 * **Ambiguity fails closed.** If more than one branch address answers to the same Ringotel domain there
 * is no way to tell which tenant the caller meant, and picking one would route a login into somebody
 * else's domain. `ambiguous` is reported distinctly from `not-found` so the operator can see the
 * difference in the logs — the fixes are different (`SSO_RT_DOMAIN_MAP` vs a Ringotel data problem).
 *
 * Only orgs whose OWN `domain` matches are searched. A branch carrying a domain that differs from its
 * org's would need a sweep of every org's branches on an unauthenticated request, which is exactly the
 * shape of request not worth spending API calls on; `SSO_RT_DOMAIN_MAP` covers that case explicitly.
 */
export async function resolveNsDomainByRtDomain(read: OrgBranchReader, rtDomain: string): Promise<RtDomainLookup> {
  const want = rtDomain.trim().toLowerCase();
  if (!want) return { ok: false, reason: 'not-found' };

  const orgs = await read.getOrganizations();
  const candidates = orgs.filter((o) => str(o.domain).toLowerCase() === want && str(o.id));
  if (!candidates.length) return { ok: false, reason: 'not-found' };

  const addresses = new Set<string>();
  for (const org of candidates) {
    const branches = await read.getBranches(String(org.id));
    for (const b of branches) {
      const address = str(b.address);
      if (!address) continue;
      // A branch with its OWN domain answers only for that domain; one without inherits its org's,
      // which already matched. This keeps a multi-branch org from resolving every branch to `want`.
      const branchDomain = str(b.domain).toLowerCase();
      if (branchDomain && branchDomain !== want) continue;
      addresses.add(address.toLowerCase());
    }
  }
  if (addresses.size === 0) return { ok: false, reason: 'not-found' };
  if (addresses.size > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, nsDomain: [...addresses][0]! };
}
