import { describe, it, expect } from 'vitest';
import { resolveOrgBranch, type OrgBranchReader } from './orgBranch.js';

const reader = (orgs: any[], branches: Record<string, any[]>): OrgBranchReader => ({
  getOrganizations: async () => orgs,
  getBranches: async (orgid) => branches[orgid] ?? [],
});

describe('resolveOrgBranch', () => {
  it('resolves via default transform (first label → org.domain) + branch address match', async () => {
    const r = reader([{ id: 'O1', domain: 'demo' }], { O1: [{ id: 'B1', address: 'demo.12345.service' }] });
    expect(await resolveOrgBranch(r, 'demo.12345.service', {})).toEqual({ orgid: 'O1', branchid: 'B1', rtDomain: 'demo' });
  });

  it('honors an override map when first-label != org key', async () => {
    const r = reader([{ id: 'O1', domain: 'acme' }], { O1: [{ id: 'B1', address: 'legacy.999.service' }] });
    const mapping = { rules: [{ match: 'legacy', to: 'acme' }] };
    expect(await resolveOrgBranch(r, 'legacy.999.service', mapping)).toEqual({ orgid: 'O1', branchid: 'B1', rtDomain: 'acme' });
  });

  it('returns null when no org maps', async () => {
    const r = reader([{ id: 'O1', domain: 'other' }], {});
    expect(await resolveOrgBranch(r, 'demo.12345.service', {})).toBeNull();
  });

  it('returns null when the org has no branch whose address matches the domain', async () => {
    const r = reader([{ id: 'O1', domain: 'demo' }], { O1: [{ id: 'B1', address: 'somethingelse.1.service' }] });
    expect(await resolveOrgBranch(r, 'demo.12345.service', {})).toBeNull();
  });

  it('rtDomain comes from branch.domain when present, even if it differs from org.domain', async () => {
    // org.domain ('demo') still drives the org-mapping match (first-label default transform); the
    // branch's own `domain` ('demo-branch') is a distinct value and must win for rtDomain.
    const r = reader(
      [{ id: 'O1', domain: 'demo' }],
      { O1: [{ id: 'B1', address: 'demo.12345.service', domain: 'demo-branch' }] },
    );
    const result = await resolveOrgBranch(r, 'demo.12345.service', {});
    expect(result?.rtDomain).toBe('demo-branch');
  });

  it('rtDomain falls back to org.domain when the matched branch has none', async () => {
    const r = reader(
      [{ id: 'O1', domain: 'demo' }],
      { O1: [{ id: 'B1', address: 'demo.12345.service' }] },
    );
    const result = await resolveOrgBranch(r, 'demo.12345.service', {});
    expect(result?.rtDomain).toBe('demo');
  });

  it('rtDomain is "" (resolution still succeeds) when neither branch nor org carries a domain', async () => {
    // Org has no `domain` field, so route the org match through an override rule targeting the org's
    // `id` directly (findOrg's `auto` mode falls back to an exact id match) rather than the default
    // first-label→org.domain transform.
    const r = reader(
      [{ id: 'O1' }],
      { O1: [{ id: 'B1', address: 'demo.12345.service' }] },
    );
    const mapping = { rules: [{ match: 'demo', to: 'O1' }] };
    const result = await resolveOrgBranch(r, 'demo.12345.service', mapping);
    expect(result).toEqual({ orgid: 'O1', branchid: 'B1', rtDomain: '' });
  });
});
