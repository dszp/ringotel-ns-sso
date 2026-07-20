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
