import type { CanonicalVerdict } from '@dszp/ringotel-lib';

export type Mode = 'validate' | 'heal' | 'provision';
export type Action = 'allow' | 'heal' | 'provision' | 'deny';
export interface Decision { action: Action; reason: string }

function inList(list: string[] | '*', domain: string): boolean {
  if (list === '*') return true;
  const d = domain.toLowerCase();
  return list.some((x) => x.toLowerCase() === d);
}

type List = string[] | '*';

export interface ModeLists {
  heal: List;
  provision: List;
  /** Refuses heal for these domains even when `heal` would allow it. Block always wins. */
  healBlock?: List;
  /** Refuses provisioning for these domains even when `provision` would allow it. Block always wins. */
  provisionBlock?: List;
}

/** Permitted = on the allowlist AND not on the blocklist. Block always wins, by design: the intended
 *  configuration is a broad allowlist (often `*`) narrowed by a short blocklist. */
const permits = (allow: List, block: List | undefined, domain: string): boolean =>
  inList(allow, domain) && !(block !== undefined && inList(block, domain));

/**
 * Is HEALING permitted for this domain, independently of which mode was selected? This is a separate
 * question from `modeFor` because `provision` mode also performs heal actions (an inactive or duplicated
 * record is reactivated rather than created). Without asking it separately, a domain listed in the heal
 * blocklist would still be healed whenever provisioning was permitted — the blocklist would silently do
 * nothing on any `provision: '*'` deployment.
 */
export function healPermitted(domain: string, lists: Pick<ModeLists, 'heal' | 'healBlock'>): boolean {
  return permits(lists.heal, lists.healBlock, domain);
}

/** Provision beats heal beats validate — but a blocked domain falls through to the weaker mode, so
 *  blocking provisioning on a `*`-provision deployment leaves heal (if permitted), not nothing. */
export function modeFor(domain: string, lists: ModeLists): Mode {
  if (permits(lists.provision, lists.provisionBlock, domain)) return 'provision';
  if (permits(lists.heal, lists.healBlock, domain)) return 'heal';
  return 'validate';
}

const writeMode = (m: Mode): boolean => m === 'heal' || m === 'provision';

/**
 * Decide the action. Fail-closed: anything that isn't provably a single clean active user, in a mode
 * permitted to make it so, denies. `eligible` gates CREATION only (verdict 'none' + provision).
 */
export function decide(
  verdict: CanonicalVerdict,
  mode: Mode,
  eligible: boolean,
  /** Whether healing is permitted for this domain. Required, and separate from `mode`, because
   *  `provision` mode also heals — see `healPermitted`. Passing `true` blindly reintroduces the bug
   *  where a heal-blocked domain is healed anyway on a provision-enabled deployment. */
  canHeal: boolean,
): Decision {
  const mayHeal = writeMode(mode) && canHeal;
  switch (verdict) {
    case 'active':
      return { action: 'allow', reason: 'single active user' };
    case 'inactive-exists':
      return mayHeal
        ? { action: 'heal', reason: 'reactivate inactive user' }
        : { action: 'deny', reason: 'user inactive; healing not enabled for this domain' };
    case 'ambiguous':
      return mayHeal
        ? { action: 'heal', reason: 'dedup siblings then reactivate canonical' }
        : { action: 'deny', reason: 'multiple records at extension; healing not enabled for this domain' };
    case 'none':
      if (mode !== 'provision') return { action: 'deny', reason: 'no user; provisioning not enabled for this domain' };
      return eligible
        ? { action: 'provision', reason: 'create+activate eligible new user' }
        : { action: 'deny', reason: 'no user; NS user is not eligible for auto-provision' };
    default: {
      const _exhaustive: never = verdict;
      return { action: 'deny', reason: `unknown verdict: ${String(_exhaustive)}` };
    }
  }
}
