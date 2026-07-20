import { describe, it, expect, vi } from 'vitest';
import { authorize, type AuthorizeDeps } from './authorize.js';
import { parseConfig, type Env } from './config.js';

const env = (over: Partial<Env> = {}): Env => ({
  SSO_BASIC_USER: 'r', SSO_BASIC_PASSWORD: 'p',
  NS_SERVER: 'api.example.com', NS_OAUTH_CLIENT_ID: 'c', NS_OAUTH_CLIENT_SECRET: 's',
  RINGOTEL_API_KEY: 'rt', NS_API_KEY: 'nst', ...over,
});

const baseSelf = {
  user: '100', domain: 'demo.12345.service',
  email: 'al@example.com', 'name-first-name': 'Al', 'name-last-name': 'Ice',
};
const okAuth = { authenticate: async () => ({ ok: true, self: baseSelf }) };
const orgBranchReader = {
  getOrganizations: async () => [{ id: 'O1', domain: 'demo' }],
  getBranches: async () => [{ id: 'B1', address: 'demo.12345.service' }],
};
const input = { username: '100@demo', password: 'pw', domain: 'demo.12345.service' };

/** A single active, SIP-linked record at ext 100 — verdict 'active', the shape an `allow` needs. */
const activeReader = { ...orgBranchReader, getUsers: async () => [
  { id: 'A', branchid: 'B1', extension: '100', status: 1, username: '100r', authname: '100r' },
] };

/** A single inactive record at ext 100 — verdict 'inactive-exists', the shape a heal needs. Shared by
 *  the heal tests and the repair-task tests below so the fixture can't drift between them. */
const inactiveReader = { ...orgBranchReader, getUsers: async () => [
  { id: 'A', branchid: 'B1', extension: '100', status: -1, username: '100r', authname: '100r' },
] };

function deps(over: Partial<AuthorizeDeps> = {}, cfgEnv: Env = env()): AuthorizeDeps {
  return {
    config: parseConfig(cfgEnv),
    auth: okAuth,
    read: { ...orgBranchReader, getUsers: async () => [] },
    getWrite: async () => { throw new Error('no write in this test'); },
    ...over,
  } as AuthorizeDeps;
}

describe('authorize', () => {
  it('403 on bad credentials, no Ringotel calls', async () => {
    const read = { ...orgBranchReader, getUsers: vi.fn(async () => []) };
    const r = await authorize(input, deps({ auth: { authenticate: async () => ({ ok: false }) }, read } as any));
    expect(r.status).toBe(403);
    expect(read.getUsers).not.toHaveBeenCalled();
  });

  it('200 for a single active user (validate mode, no writes)', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [
      { id: 'A', branchid: 'B1', extension: '100', status: 1, username: '100r', authname: '100r' },
    ] };
    const r = await authorize(input, deps({ read } as any));
    expect(r.status).toBe(200);
    // `domain` in the success body is the Ringotel org domain (`org.domain` here, since the fixture
    // branch carries no `domain` of its own) — NOT the NetSapiens domain.
    expect(r.body).toEqual({ extension: '100', authname: '100r', domain: 'demo' });
  });

  it('403 for an inactive user when the domain is validate-only', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [
      { id: 'A', branchid: 'B1', extension: '100', status: -1, authname: '100r' },
    ] };
    const r = await authorize(input, deps({ read } as any));
    expect(r.status).toBe(403);
  });

  it('provisions a new user on a provision-listed domain and returns 200', async () => {
    const createUser = vi.fn(async (_args: Record<string, unknown>) => ({ id: 'NEW' }));
    const createDevice = vi.fn(async () => ({ 'device-sip-registration-password': 'sippw' }));
    const read = {
      ...orgBranchReader,
      getUsers: async () => [], // verdict 'none'
    };
    const ns = {
      getDevices: async () => [],
      getDevice: async () => ({}),
      createDevice,
    };
    const auth = { authenticate: async () => ({ ok: true, self: baseSelf }) }; // has email, no srv_code
    const d = deps({
      auth,
      read,
      getWrite: async () => ({ rt: { createUser, updateUser: vi.fn(), deleteUser: vi.fn() }, ns }),
    } as any, env({ SSO_PROVISION_DOMAINS: 'demo.12345.service' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(200);
    expect(createDevice).toHaveBeenCalledWith('demo.12345.service', '100', '100r');
    expect(createUser).toHaveBeenCalledOnce();
    expect(createUser.mock.calls[0]?.[0]).toMatchObject({ name: 'Al Ice', email: 'al@example.com' });
    expect(r.body?.authname).toBe('100r');
  });

  it('denies provision when the NS user is ineligible (system user)', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [] };
    const ns = { getDevices: async () => [], getDevice: async () => ({}), createDevice: vi.fn() };
    const auth = { authenticate: async () => ({ ok: true, self: { ...baseSelf, 'service-code': 'sys' } }) }; // HARD block
    const createUser = vi.fn();
    const d = deps({ auth, read, getWrite: async () => ({ rt: { createUser, updateUser: vi.fn(), deleteUser: vi.fn() }, ns }) } as any,
      env({ SSO_PROVISION_DOMAINS: 'demo.12345.service' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(403);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('403 on cross-tenant domain mismatch, no Ringotel calls', async () => {
    const read = { ...orgBranchReader, getUsers: vi.fn(async () => []) };
    const auth = { authenticate: async () => ({ ok: true, self: { ...baseSelf, domain: 'other.999.service' } }) };
    const r = await authorize(input, deps({ auth, read } as any));
    expect(r.status).toBe(403);
    expect(read.getUsers).not.toHaveBeenCalled();
  });

  it('no `domain` in the input (real Ringotel shape): proceeds normally, 200 with the self-derived domain', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [
      { id: 'A', branchid: 'B1', extension: '100', status: 1, username: '100r', authname: '100r' },
    ] };
    const noDomainInput = { username: '100@demo', password: 'pw' };
    const r = await authorize(noDomainInput, deps({ read } as any));
    expect(r.status).toBe(200);
    // Success-body `domain` is still the Ringotel org domain, independent of whether the caller
    // supplied `input.domain` — mode selection etc. keep using the self-derived NS domain (asserted via
    // `r.log.domain` implicitly staying NS-shaped through the rest of this suite).
    expect(r.body).toEqual({ extension: '100', authname: '100r', domain: 'demo' });
    expect(r.log.domainCheck).toBe('skipped-not-supplied');
  });

  it('a mismatched supplied `domain` still 403s domain-mismatch (existing behavior preserved)', async () => {
    const read = { ...orgBranchReader, getUsers: vi.fn(async () => []) };
    const mismatchInput = { ...input, domain: 'other.999.service' };
    const r = await authorize(mismatchInput, deps({ read } as any));
    expect(r.status).toBe(403);
    expect(r.log.reason).toBe('domain-mismatch');
    expect(read.getUsers).not.toHaveBeenCalled();
  });

  it('a matching supplied `domain` proceeds (200) and records domainCheck=ok', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [
      { id: 'A', branchid: 'B1', extension: '100', status: 1, username: '100r', authname: '100r' },
    ] };
    const r = await authorize(input, deps({ read } as any)); // `input` already carries the matching domain
    expect(r.status).toBe(200);
    expect(r.log.domainCheck).toBe('ok');
  });

  it('403 when two records at the extension both carry the SIP identity (unpickable ambiguous)', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [
      { id: 'A', branchid: 'B1', extension: '100', status: 1, username: '100r', authname: '100r' },
      { id: 'B', branchid: 'B1', extension: '100', status: 1, username: '100r', authname: '100r' },
    ] };
    const updateUser = vi.fn();
    const createUser = vi.fn();
    const d = deps({ read, getWrite: async () => ({ rt: { createUser, updateUser, deleteUser: vi.fn() }, ns: {} as any }) } as any,
      env({ SSO_HEAL_DOMAINS: 'demo.12345.service' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(403);
    expect(updateUser).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it('dedup tolerates a failing sibling delete and still heals the canonical', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [
      { id: 'A', branchid: 'B1', extension: '100', status: 1, username: '100r', authname: '100r' },
      { id: 'PHANTOM', branchid: 'B1', extension: '100', status: -1, username: 'phantom', authname: 'phantom' },
    ] };
    const updateUser = vi.fn(async (_id: string, _orgid: string, _changes: Record<string, unknown>) => ({}));
    const deleteUser = vi.fn(async () => { throw new Error('un-deletable tombstone'); });
    const ns = {
      getDevices: async () => [],
      getDevice: async () => ({}),
      createDevice: vi.fn(async () => ({ 'device-sip-registration-password': 'sippw' })),
    };
    const d = deps({ read, getWrite: async () => ({ rt: { createUser: vi.fn(), updateUser, deleteUser }, ns }) } as any,
      env({ SSO_HEAL_DOMAINS: 'demo.12345.service' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(200);
    expect(deleteUser).toHaveBeenCalledWith('PHANTOM', 'O1');
    expect(updateUser).toHaveBeenCalledOnce();
    // Reactivation also syncs the NS identity (name + email from `self`), mirroring the companion portal's
    // activate() — a healed record must not keep stale directory data.
    expect(updateUser.mock.calls[0]?.[2]).toMatchObject({ status: 1, name: 'Al Ice', email: 'al@example.com' });
  });

  it('heals a single inactive-exists user on a heal domain, syncing NS name+email into the reactivation', async () => {
    const updateUser = vi.fn(async (_id: string, _orgid: string, _changes: Record<string, unknown>) => ({}));
    const ns = {
      getDevices: async () => [],
      getDevice: async () => ({}),
      createDevice: vi.fn(async () => ({ 'device-sip-registration-password': 'sippw' })),
    };
    const d = deps({ read: inactiveReader, getWrite: async () => ({ rt: { createUser: vi.fn(), updateUser, deleteUser: vi.fn() }, ns }) } as any,
      env({ SSO_HEAL_DOMAINS: 'demo.12345.service' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(200);
    expect(updateUser).toHaveBeenCalledOnce();
    expect(updateUser.mock.calls[0]?.[2]).toMatchObject({ status: 1, username: '100r', authname: '100r', name: 'Al Ice', email: 'al@example.com' });
  });

  it('firstEmail picks the first non-blank element when self.email is an array', async () => {
    const createUser = vi.fn(async (_args: Record<string, unknown>) => ({ id: 'NEW' }));
    const read = { ...orgBranchReader, getUsers: async () => [] };
    const ns = {
      getDevices: async () => [],
      getDevice: async () => ({}),
      createDevice: vi.fn(async () => ({ 'device-sip-registration-password': 'sippw' })),
    };
    const auth = { authenticate: async () => ({ ok: true, self: { ...baseSelf, email: ['a@example.com', 'b@example.com'] } }) };
    const d = deps({
      auth,
      read,
      getWrite: async () => ({ rt: { createUser, updateUser: vi.fn(), deleteUser: vi.fn() }, ns }),
    } as any, env({ SSO_PROVISION_DOMAINS: 'demo.12345.service' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(200);
    expect(createUser.mock.calls[0]?.[0]).toMatchObject({ email: 'a@example.com' });
  });

  it('F1: heal activates the canonical BEFORE deleting non-canonical siblings (brick-window fix)', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [
      { id: 'A', branchid: 'B1', extension: '100', status: 1, username: '100r', authname: '100r' },
      { id: 'PHANTOM', branchid: 'B1', extension: '100', status: -1, username: 'phantom', authname: 'phantom' },
    ] };
    const calls: string[] = [];
    const updateUser = vi.fn(async (id: string) => { calls.push(`update:${id}`); return {}; });
    const deleteUser = vi.fn(async (id: string) => { calls.push(`delete:${id}`); });
    const ns = {
      getDevices: async () => [],
      getDevice: async () => ({}),
      createDevice: vi.fn(async () => ({ 'device-sip-registration-password': 'sippw' })),
    };
    const d = deps({ read, getWrite: async () => ({ rt: { createUser: vi.fn(), updateUser, deleteUser }, ns }) } as any,
      env({ SSO_HEAL_DOMAINS: 'demo.12345.service' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(200);
    // The canonical must be reactivated before the sibling delete is attempted — reversing this order
    // reopens the brick window an SSO bind could land in.
    expect(calls).toEqual(['update:A', 'delete:PHANTOM']);
  });

  it('M1: 403 no-sip-password (not a Ringotel write) when ensureDevice returns a blank password on heal', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [
      { id: 'A', branchid: 'B1', extension: '100', status: -1, username: '100r', authname: '100r' },
    ] };
    const updateUser = vi.fn();
    const ns = {
      getDevices: async () => [],
      getDevice: async () => ({}),
      createDevice: vi.fn(async () => ({ 'device-sip-registration-password': '' })),
    };
    const d = deps({ read, getWrite: async () => ({ rt: { createUser: vi.fn(), updateUser, deleteUser: vi.fn() }, ns }) } as any,
      env({ SSO_HEAL_DOMAINS: 'demo.12345.service' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(403);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('M1: 403 no-sip-password (not a Ringotel write) when ensureDevice returns a blank password on provision', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [] };
    const createUser = vi.fn();
    const ns = {
      getDevices: async () => [],
      getDevice: async () => ({}),
      createDevice: vi.fn(async () => ({ 'device-sip-registration-password': '' })),
    };
    const d = deps({ read, getWrite: async () => ({ rt: { createUser, updateUser: vi.fn(), deleteUser: vi.fn() }, ns }) } as any,
      env({ SSO_PROVISION_DOMAINS: 'demo.12345.service' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(403);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('M8: a system/service user with an existing deactivated record on a heal domain is not reactivated', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [
      { id: 'A', branchid: 'B1', extension: '100', status: -1, username: '100r', authname: '100r' },
    ] };
    const updateUser = vi.fn();
    const deleteUser = vi.fn();
    const auth = { authenticate: async () => ({ ok: true, self: { ...baseSelf, 'service-code': 'sys' } }) }; // HARD block
    const ns = { getDevices: async () => [], getDevice: async () => ({}), createDevice: vi.fn() };
    const d = deps({ auth, read, getWrite: async () => ({ rt: { createUser: vi.fn(), updateUser, deleteUser }, ns }) } as any,
      env({ SSO_HEAL_DOMAINS: 'demo.12345.service' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(403);
    expect(updateUser).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('F3: a record whose name is only under display-name is soft-excluded from provisioning (SHARED)', async () => {
    const read = { ...orgBranchReader, getUsers: async () => [] };
    const createUser = vi.fn();
    const auth = { authenticate: async () => ({
      ok: true,
      self: { user: '101', domain: 'demo.12345.service', email: 'shared@example.com', 'display-name': 'SHARED VOICEMAIL' },
    }) };
    const ns = { getDevices: async () => [], getDevice: async () => ({}), createDevice: vi.fn() };
    const d = deps({ auth, read, getWrite: async () => ({ rt: { createUser, updateUser: vi.fn(), deleteUser: vi.fn() }, ns }) } as any,
      env({ SSO_PROVISION_DOMAINS: 'demo.12345.service' }));
    const altInput = { username: '101@demo', password: 'pw', domain: 'demo.12345.service' };
    const r = await authorize(altInput, d);
    expect(r.status).toBe(403);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('200 body carries the Ringotel org domain while the NS domain still drives mode selection', async () => {
    // Ringotel org domain ('rt-demo') is deliberately distinct from the NS domain ('demo.12345.service'),
    // which is what's on the provision allowlist below — proving mode selection still keys off NS, while
    // the response body carries the Ringotel one.
    const read = {
      getOrganizations: async () => [{ id: 'O1', domain: 'demo' }],
      getBranches: async () => [{ id: 'B1', address: 'demo.12345.service', domain: 'rt-demo' }],
      getUsers: async () => [], // verdict 'none'
    };
    const createUser = vi.fn(async (_args: Record<string, unknown>) => ({ id: 'NEW' }));
    const ns = {
      getDevices: async () => [],
      getDevice: async () => ({}),
      createDevice: vi.fn(async () => ({ 'device-sip-registration-password': 'sippw' })),
    };
    const d = deps({
      read,
      getWrite: async () => ({ rt: { createUser, updateUser: vi.fn(), deleteUser: vi.fn() }, ns }),
    } as any, env({ SSO_PROVISION_DOMAINS: 'demo.12345.service' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(200);
    expect(r.body?.domain).toBe('rt-demo');
    // The provision path actually ran (i.e. mode selection used the NS domain, which is on the
    // allowlist, not the Ringotel domain, which isn't).
    expect(createUser).toHaveBeenCalledOnce();
    expect(createUser.mock.calls[0]?.[0]).toMatchObject({ domain: 'demo.12345.service' });
  });

  it('falls back to the NS domain in the response body when rtDomain resolves empty', async () => {
    const read = {
      getOrganizations: async () => [{ id: 'O1' }], // no org.domain
      getBranches: async () => [{ id: 'B1', address: 'demo.12345.service' }], // no branch.domain
      getUsers: async () => [
        { id: 'A', branchid: 'B1', extension: '100', status: 1, username: '100r', authname: '100r' },
      ],
    };
    // Route org resolution through an override rule targeting the org's `id`, since org.domain is
    // absent — SSO_DOMAIN_MAP is parsed by config.ts as JSON firstLabel→orgKey.
    const r = await authorize(input, deps({ read } as any, env({ SSO_DOMAIN_MAP: '{"demo":"O1"}' })));
    expect(r.status).toBe(200);
    expect(r.body?.domain).toBe('demo.12345.service');
    expect(r.log.rtDomainFallback).toBe(true);
  });

  it('allow on a repair domain emits a repair task', async () => {
    const r = await authorize(input, deps({ read: activeReader } as any, env({ SSO_REPAIR_DOMAINS: 'demo.12345.service' })));
    expect(r.status).toBe(200);
    expect(r.repair).toMatchObject({ domain: 'demo.12345.service', ext: '100', device: '100r' });
  });

  it('the repair task carries the resolved record id and its current authname', async () => {
    const r = await authorize(input, deps({ read: activeReader } as any, env({ SSO_REPAIR_DOMAINS: '*' })));
    expect(r.repair?.userId).toBeTruthy();
    expect(r.repair?.authname).toBe('100r');
  });

  it('an ACTIVE record with NO authname field gets a repair task that fails the drift gate ' +
    '(does not equal the device name), even though the 200 body still falls back to <ext><suffix>', async () => {
    // `??` only fires on null/undefined — a record with authname genuinely ABSENT (not present-but-
    // wrong) must not let the repair descriptor inherit the same `ext + suffix` fallback the HTTP body
    // uses, or `runDeviceRepair`'s `task.authname !== task.device` gate passes having verified nothing
    // against exactly the most dangerous target: an active record with no SIP identity at all.
    const read = { ...orgBranchReader, getUsers: async () => [
      { id: 'A', branchid: 'B1', extension: '100', status: 1, username: '100r' /* no authname */ },
    ] };
    const r = await authorize(input, deps({ read } as any, env({ SSO_REPAIR_DOMAINS: 'demo.12345.service' })));
    expect(r.status).toBe(200);
    // Intentional, pre-existing behaviour: the HTTP body's authname still falls back to <ext><suffix>.
    expect(r.body).toEqual({ extension: '100', authname: '100r', domain: 'demo' });
    // The repair task must NOT get the same fallback — it must fail the drift check.
    expect(r.repair).toBeDefined();
    expect(r.repair?.authname).not.toBe(r.repair?.device);
  });

  it('allow on a NON-repair domain emits no repair task', async () => {
    const r = await authorize(input, deps({ read: activeReader } as any, env()));
    expect(r.status).toBe(200);
    expect(r.repair).toBeUndefined();
  });

  it('heal never emits a repair task (it already wrote the device)', async () => {
    // Same inactive-record fixture the heal-path tests above use, so the verdict is `inactive-exists`
    // and the mode is heal — heal needs a working write client too (it recreates the device inline).
    const updateUser = vi.fn(async () => ({}));
    const ns = {
      getDevices: async () => [],
      getDevice: async () => ({}),
      createDevice: vi.fn(async () => ({ 'device-sip-registration-password': 'sippw' })),
    };
    const d = deps({ read: inactiveReader, getWrite: async () => ({ rt: { createUser: vi.fn(), updateUser, deleteUser: vi.fn() }, ns }) } as any,
      env({ SSO_REPAIR_DOMAINS: '*', SSO_HEAL_DOMAINS: '*' }));
    const r = await authorize(input, d);
    expect(r.status).toBe(200);
    expect(r.repair).toBeUndefined();
  });
});

describe('activation email preference', () => {
  const STUB = { getDevices: async () => [], getDevice: async () => ({}), createDevice: async () => ({ 'device-sip-registration-password': 'sippw' }) } as any;
  // The credentials email fires when a write carries BOTH status:1 and an email field, which every
  // heal/provision write does. `noemail` inverts the preference, so the DEFAULT must be noemail:true.
  const captureUpdate = () => {
    const calls: any[] = [];
    return { calls, rt: { updateUser: async (...a: any[]) => { calls.push(a); return {}; },
                          createUser: async (...a: any[]) => { calls.push(a); return {}; },
                          deleteUser: async () => ({}) } };
  };

  it('provision sends noemail:true by default', async () => {
    const cap = captureUpdate();
    const d = deps({ getWrite: async () => ({ rt: cap.rt as any, ns: { getDevices: async () => [], getDevice: async () => ({}), createDevice: async () => ({ 'device-sip-registration-password': 'sippw' }) } as any }) }, env({ SSO_PROVISION_DOMAINS: '*' }));
    await authorize(input, d);
    const body = cap.calls.at(-1)![0];
    expect(body.noemail).toBe(true);
  });

  it('HEAL sends noemail:true by default (reactivating an existing record)', async () => {
    const cap = captureUpdate();
    const d = deps({ read: inactiveReader, getWrite: async () => ({ rt: cap.rt as any, ns: STUB }) } as any,
                   env({ SSO_HEAL_DOMAINS: '*' }));
    await authorize(input, d);
    const body = cap.calls.at(-1)![2];
    expect(body.status).toBe(1);
    expect(body.noemail).toBe(true);
  });

  it('HEAL sends noemail:false when the preference is enabled', async () => {
    const cap = captureUpdate();
    const d = deps({ read: inactiveReader, getWrite: async () => ({ rt: cap.rt as any, ns: STUB }) } as any,
                   env({ SSO_HEAL_DOMAINS: '*', SSO_SEND_ACTIVATION_EMAIL: '1' }));
    await authorize(input, d);
    const body = cap.calls.at(-1)![2];
    expect(body.noemail).toBe(false);
  });

  it('provision sends noemail:false when SSO_SEND_ACTIVATION_EMAIL is truthy', async () => {
    const cap = captureUpdate();
    const d = deps({ getWrite: async () => ({ rt: cap.rt as any, ns: { getDevices: async () => [], getDevice: async () => ({}), createDevice: async () => ({ 'device-sip-registration-password': 'sippw' }) } as any }) },
                   env({ SSO_PROVISION_DOMAINS: '*', SSO_SEND_ACTIVATION_EMAIL: 'true' }));
    await authorize(input, d);
    const body = cap.calls.at(-1)![0];
    expect(body.noemail).toBe(false);
  });
});

describe('domain blocklists', () => {
  const STUB2 = { getDevices: async () => [], getDevice: async () => ({}), createDevice: async () => ({ 'device-sip-registration-password': 'sippw' }) } as any;

  it('a blocked domain is refused even with valid credentials', async () => {
    const r = await authorize(input, deps({ read: activeReader } as any, env({ SSO_BLOCK_DOMAINS: 'demo.12345.service' })));
    expect(r.status).toBe(403);
    expect(r.log.reason).toBe('domain-blocked');
  });

  it('the block is refused BEFORE any Ringotel read (no org/branch lookup)', async () => {
    const getUsers = vi.fn(async () => []);
    const r = await authorize(input, deps({ read: { ...orgBranchReader, getUsers } } as any,
                                          env({ SSO_BLOCK_DOMAINS: '*' })));
    expect(r.status).toBe(403);
    expect(getUsers).not.toHaveBeenCalled();
  });

  it('an unrelated blocked domain does not affect this one', async () => {
    const r = await authorize(input, deps({ read: activeReader } as any, env({ SSO_BLOCK_DOMAINS: 'other.12345.service' })));
    expect(r.status).toBe(200);
  });

  it('repairBlock suppresses the repair task on an otherwise repair-enabled domain', async () => {
    const r = await authorize(input, deps({ read: activeReader } as any,
      env({ SSO_REPAIR_DOMAINS: '*', SSO_REPAIR_BLOCK_DOMAINS: 'demo.12345.service' })));
    expect(r.status).toBe(200);
    expect(r.repair).toBeUndefined();
  });

  it('provisionBlock demotes a *-provision domain so a missing user is denied', async () => {
    const r = await authorize(input, deps({ read: { ...orgBranchReader, getUsers: async () => [] }, getWrite: async () => ({ rt: {} as any, ns: STUB2 }) } as any,
      env({ SSO_PROVISION_DOMAINS: '*', SSO_PROVISION_BLOCK_DOMAINS: 'demo.12345.service' })));
    expect(r.status).toBe(403);
  });
});

describe('email precondition waiver (SSO_REQUIRE_EMAIL)', () => {
  const NS = { getDevices: async () => [], getDevice: async () => ({}), createDevice: async () => ({ 'device-sip-registration-password': 'sippw' }) } as any;
  // A self-record with NO email address, and no Ringotel user at the extension -> provision path.
  const noEmailAuth = { authenticate: async () => ({ ok: true, self: { ...baseSelf, email: undefined, 'email-address': undefined } }) };
  const emptyReader = { ...orgBranchReader, getUsers: async () => [] };
  const run = (over: Partial<Env> = {}) => authorize(input, deps(
    { auth: noEmailAuth as any, read: emptyReader, getWrite: async () => ({ rt: { createUser: async () => ({}), updateUser: async () => ({}), deleteUser: async () => ({}) } as any, ns: NS }) } as any,
    env({ SSO_PROVISION_DOMAINS: '*', ...over })));

  it('default (auto + email suppressed): a user with no address IS provisioned', async () => {
    const r = await run();
    expect(r.status).toBe(200);
    expect(r.log.emailPrecondition).toBe('waived');
  });

  it('auto + activation email ENABLED: the address is required again', async () => {
    const r = await run({ SSO_SEND_ACTIVATION_EMAIL: 'true' });
    expect(r.status).toBe(403);
    expect(r.log.emailPrecondition).toBeUndefined();
  });

  it("always: required even when no email will be sent", async () => {
    const r = await run({ SSO_REQUIRE_EMAIL: 'always' });
    expect(r.status).toBe(403);
  });

  it('never: not required even when the activation email IS enabled', async () => {
    const r = await run({ SSO_REQUIRE_EMAIL: 'never', SSO_SEND_ACTIVATION_EMAIL: 'true' });
    expect(r.status).toBe(200);
  });

  it('the waiver does NOT rescue a HARD exclusion (system user)', async () => {
    const sysAuth = { authenticate: async () => ({ ok: true, self: { ...baseSelf, email: undefined, 'service-code': 'vmail' } }) };
    const r = await authorize(input, deps({ auth: sysAuth as any, read: emptyReader } as any, env({ SSO_PROVISION_DOMAINS: '*' })));
    expect(r.status).toBe(403);
    expect(r.log.eligibility).toBe('hard');
  });
});

describe('heal syncs the NetSapiens email faithfully, including when blank', () => {
  const NS = { getDevices: async () => [], getDevice: async () => ({}), createDevice: async () => ({ 'device-sip-registration-password': 'sippw' }) } as any;
  const capture = () => {
    const calls: any[] = [];
    return { calls, rt: { updateUser: async (...a: any[]) => { calls.push(a); return {}; }, createUser: async () => ({}), deleteUser: async () => ({}) } };
  };
  const heal = async (self: any) => {
    const cap = capture();
    await authorize(input, deps({
      auth: { authenticate: async () => ({ ok: true, self }) } as any,
      read: inactiveReader,
      getWrite: async () => ({ rt: cap.rt as any, ns: NS }),
    } as any, env({ SSO_HEAL_DOMAINS: '*' })));
    return cap.calls.at(-1)![2];
  };

  it('propagates a REMOVED NetSapiens address rather than preserving a stale one', async () => {
    // NetSapiens is authoritative: deleting the address there is a real change, and the Ringotel
    // directory entry must not keep quietly disagreeing with it.
    const body = await heal({ ...baseSelf, email: undefined, 'email-address': undefined });
    expect(body.email).toBe('');
    expect(body.status).toBe(1);
  });

  it('syncs the address when there is one', async () => {
    expect((await heal({ ...baseSelf, email: 'user@example.com' })).email).toBe('user@example.com');
  });
});

describe('SSO_BLOCK_EXTS gates every device-creating path', () => {
  const NS = { getDevices: async () => [], getDevice: async () => ({}), createDevice: async () => ({ 'device-sip-registration-password': 'sippw' }) } as any;
  const RT = { createUser: async () => ({}), updateUser: async () => ({}), deleteUser: async () => ({}) } as any;
  const W = { getWrite: async () => ({ rt: RT, ns: NS }) };

  it('provision is refused for a blocked extension', async () => {
    const r = await authorize(input, deps({ read: { ...orgBranchReader, getUsers: async () => [] }, ...W } as any,
      env({ SSO_PROVISION_DOMAINS: '*', SSO_BLOCK_EXTS: '100' })));
    expect(r.status).toBe(403);
    expect(r.log.reason).toBe('ext-blocked');
  });

  it('HEAL is refused too — the gap a soft exclusion leaves open', async () => {
    const r = await authorize(input, deps({ read: inactiveReader, ...W } as any,
      env({ SSO_HEAL_DOMAINS: '*', SSO_BLOCK_EXTS: '100' })));
    expect(r.status).toBe(403);
    expect(r.log.reason).toBe('ext-blocked');
  });

  it('REPAIR is skipped, so no device is recreated behind an allowed login', async () => {
    const r = await authorize(input, deps({ read: activeReader } as any,
      env({ SSO_REPAIR_DOMAINS: '*', SSO_BLOCK_EXTS: '100' })));
    expect(r.status).toBe(200);
    expect(r.repair).toBeUndefined();
  });

  it('but an existing working user still SIGNS IN — blocking creation must not disconnect anyone', async () => {
    const r = await authorize(input, deps({ read: activeReader } as any, env({ SSO_BLOCK_EXTS: '100' })));
    expect(r.status).toBe(200);
  });

  it('a per-domain remove re-permits everything on that one domain', async () => {
    const e = env({ SSO_PROVISION_DOMAINS: '*', SSO_BLOCK_EXTS: '100',
                    SSO_BLOCK_EXTS_BY_DOMAIN: '{"demo.12345.service":{"remove":["100"]}}' });
    const r = await authorize(input, deps({ read: { ...orgBranchReader, getUsers: async () => [] }, ...W } as any, e));
    expect(r.status).toBe(200);
  });
});
