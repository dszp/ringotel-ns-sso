import { describe, it, expect } from 'vitest';
import type { CanonicalVerdict } from '@dszp/ringotel-lib';
import { decide, modeFor, healPermitted, type Mode, type Action } from './decide.js';

describe('modeFor', () => {
  it('provision wins over heal', () => expect(modeFor('d', { heal: ['d'], provision: ['d'] })).toBe('provision'));
  it('heal when only heal-listed', () => expect(modeFor('d', { heal: ['d'], provision: [] })).toBe('heal'));
  it('validate when neither', () => expect(modeFor('d', { heal: [], provision: [] })).toBe('validate'));
  it('* enables', () => expect(modeFor('anything', { heal: [], provision: '*' })).toBe('provision'));
});

describe('modeFor blocklists — block always wins', () => {
  // The intended shape: allow '*', then block the few domains that must not be written to.
  it('provisionBlock demotes a *-provision domain', () =>
    expect(modeFor('d', { heal: [], provision: '*', provisionBlock: ['d'] })).toBe('validate'));

  it('a blocked provision domain FALLS BACK to heal when heal still permits it', () =>
    expect(modeFor('d', { heal: '*', provision: '*', provisionBlock: ['d'] })).toBe('heal'));

  it('blocking both leaves validate', () =>
    expect(modeFor('d', { heal: '*', provision: '*', provisionBlock: ['d'], healBlock: ['d'] })).toBe('validate'));

  it('healBlock alone does not disturb provisioning', () =>
    expect(modeFor('d', { heal: '*', provision: '*', healBlock: ['d'] })).toBe('provision'));

  it('blocks only affect the named domain', () =>
    expect(modeFor('other', { heal: [], provision: '*', provisionBlock: ['d'] })).toBe('provision'));

  it('block is case-insensitive, like the allowlists', () =>
    expect(modeFor('D.Example.COM', { heal: [], provision: '*', provisionBlock: ['d.example.com'] })).toBe('validate'));

  it("block '*' is a kill switch for that mode", () =>
    expect(modeFor('d', { heal: [], provision: '*', provisionBlock: '*' })).toBe('validate'));

  it('an absent blocklist blocks nothing', () =>
    expect(modeFor('d', { heal: [], provision: ['d'] })).toBe('provision'));
});

describe('decide', () => {
  it('active always allows, in every mode', () => {
    for (const m of ['validate', 'heal', 'provision'] as const) expect(decide('active', m, true, true).action).toBe('allow');
  });
  it('inactive-exists: validate denies, heal/provision reactivate', () => {
    expect(decide('inactive-exists', 'validate', true, true).action).toBe('deny');
    expect(decide('inactive-exists', 'heal', true, true).action).toBe('heal');
    expect(decide('inactive-exists', 'provision', true, true).action).toBe('heal');
  });
  it('none: only provision-with-eligibility creates; else deny', () => {
    expect(decide('none', 'validate', true, true).action).toBe('deny');
    expect(decide('none', 'heal', true, true).action).toBe('deny');
    expect(decide('none', 'provision', true, true).action).toBe('provision');
    expect(decide('none', 'provision', false, true).action).toBe('deny'); // ineligible
  });
  it('ambiguous: validate denies, heal/provision dedup-then-heal', () => {
    expect(decide('ambiguous', 'validate', true, true).action).toBe('deny');
    expect(decide('ambiguous', 'heal', true, true).action).toBe('heal');
    expect(decide('ambiguous', 'provision', true, true).action).toBe('heal');
  });

  // Explicit expected-action table for the full verdict x mode x eligible matrix (24 tuples).
  // Every row is a literal, hand-written [verdict, mode, eligible, expectedAction] tuple per the
  // brick-safety contract — NOT computed by re-running decide()'s own branching logic.
  const matrix: Array<[CanonicalVerdict, Mode, boolean, Action]> = [
    // active -> allow, every mode, every eligibility
    ['active', 'validate', true, 'allow'],
    ['active', 'validate', false, 'allow'],
    ['active', 'heal', true, 'allow'],
    ['active', 'heal', false, 'allow'],
    ['active', 'provision', true, 'allow'],
    ['active', 'provision', false, 'allow'],
    // inactive-exists -> heal in heal/provision, else deny
    ['inactive-exists', 'validate', true, 'deny'],
    ['inactive-exists', 'validate', false, 'deny'],
    ['inactive-exists', 'heal', true, 'heal'],
    ['inactive-exists', 'heal', false, 'heal'],
    ['inactive-exists', 'provision', true, 'heal'],
    ['inactive-exists', 'provision', false, 'heal'],
    // ambiguous -> heal in heal/provision, else deny
    ['ambiguous', 'validate', true, 'deny'],
    ['ambiguous', 'validate', false, 'deny'],
    ['ambiguous', 'heal', true, 'heal'],
    ['ambiguous', 'heal', false, 'heal'],
    ['ambiguous', 'provision', true, 'heal'],
    ['ambiguous', 'provision', false, 'heal'],
    // none -> provision only if mode==='provision' && eligible, else deny
    ['none', 'validate', true, 'deny'],
    ['none', 'validate', false, 'deny'],
    ['none', 'heal', true, 'deny'],
    ['none', 'heal', false, 'deny'],
    ['none', 'provision', true, 'provision'],
    ['none', 'provision', false, 'deny'],
  ];

  it('full matrix: verdict x mode x eligible (24 tuples)', () => {
    expect(matrix).toHaveLength(24);
    for (const [verdict, mode, eligible, expected] of matrix) {
      const actual = decide(verdict, mode, eligible, true).action;
      expect(actual, `verdict=${verdict} mode=${mode} eligible=${eligible}`).toBe(expected);
    }
  });
});

describe('decide — heal permission is separate from mode', () => {
  // Regression: provision mode also HEALS (inactive/ambiguous records are reactivated, not created), so
  // a heal-blocked domain was still being healed on any provision-enabled deployment. The blocklist did
  // nothing wherever provisioning was permitted — which, with provision:'*', is everywhere.
  it('refuses to heal an inactive user under provision mode when healing is blocked', () => {
    const d = decide('inactive-exists', 'provision', true, false);
    expect(d.action).toBe('deny');
  });

  it('refuses to dedup+heal an ambiguous user under provision mode when healing is blocked', () => {
    expect(decide('ambiguous', 'provision', true, false).action).toBe('deny');
  });

  it('still provisions a MISSING user on that same domain — only healing is blocked', () => {
    expect(decide('none', 'provision', true, false).action).toBe('provision');
  });

  it('still allows an already-active user when healing is blocked', () => {
    expect(decide('active', 'provision', true, false).action).toBe('allow');
  });

  it('heals normally when healing is permitted', () => {
    expect(decide('inactive-exists', 'provision', true, true).action).toBe('heal');
  });
});

describe('healPermitted', () => {
  it('is false when the domain is heal-blocked, regardless of provisioning', () =>
    expect(healPermitted('d', { heal: '*', healBlock: ['d'] })).toBe(false));
  it('is true when allowed and not blocked', () =>
    expect(healPermitted('d', { heal: '*' })).toBe(true));
  it('is false when heal is not allowed at all', () =>
    expect(healPermitted('d', { heal: [] })).toBe(false));
});

describe("blocklist wildcard", () => {
  // '*' on a blocklist means 'block everywhere'. For heal this is NOT equivalent to an empty heal
  // allowlist, because provision mode heals too — so this combination is the only way to express
  // 'create missing users, but never modify existing ones'.
  it('healBlock "*" with provision "*" still provisions a missing user', () => {
    const lists = { heal: '*' as const, provision: '*' as const, healBlock: '*' as const };
    expect(modeFor('d', lists)).toBe('provision');
    expect(decide('none', 'provision', true, healPermitted('d', lists)).action).toBe('provision');
  });

  it('...but refuses to reactivate an inactive one', () => {
    const lists = { heal: '*' as const, provision: '*' as const, healBlock: '*' as const };
    expect(decide('inactive-exists', 'provision', true, healPermitted('d', lists)).action).toBe('deny');
  });

  it('...and refuses to dedup an ambiguous one', () => {
    const lists = { heal: '*' as const, provision: '*' as const, healBlock: '*' as const };
    expect(decide('ambiguous', 'provision', true, healPermitted('d', lists)).action).toBe('deny');
  });

  it('provisionBlock "*" disables provisioning everywhere', () =>
    expect(modeFor('d', { heal: [], provision: '*', provisionBlock: '*' })).toBe('validate'));
});
