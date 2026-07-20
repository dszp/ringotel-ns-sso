/**
 * Post-response device repair — the one piece of housekeeping this Worker performs on a login it has
 * ALREADY approved.
 *
 * The problem it solves: a Ringotel record can be active and perfectly valid while the softphone device
 * that backs its SIP registration has been deleted upstream. The authorize pipeline sees a healthy
 * record, answers `allow`, and writes nothing — so the user "signs in" successfully and then cannot
 * register. Nothing in the request path can detect that without an extra upstream read, and the login
 * must not pay for it.
 *
 * So this runs from `ctx.waitUntil()` AFTER the response is sent: it costs the caller no latency, it
 * cannot influence the answer, and — because a login is exactly when the user is about to need working
 * credentials — the repair lands in time for their client's next registration attempt.
 *
 * It is gated by SSO_REPAIR_DOMAINS (default OFF) and returns a log record instead of throwing:
 * `waitUntil` work is invisible to the caller, so an unlogged failure here would be undetectable.
 *
 * SAFETY — repair only proceeds when the Ringotel record's `authname` already equals the expected
 * `<ext><suffix>`. A record whose authname has drifted has no unambiguous correct device name, and a
 * wrong write against a mismatched record is how extensions get permanently stranded on this platform.
 * Drift is reported and left alone. A recreated device that yields no SIP password is likewise never
 * pushed, since that would replace a working credential with an empty one.
 *
 * KNOWN GAP — if `createDevice` below succeeds but the following `rt.updateUser(...)` throws, the
 * device exists upstream with a password Ringotel never received, and every later check self-masks it
 * (`result: 'ok'`, existence-only) until a human notices the `result: 'error'` log line from the run
 * that actually failed. Accepted at-least-once behaviour, not fixed here — see ARCHITECTURE.md's
 * "Post-response repair" section.
 */

import { SIP_PW_FIELD, type AuthorizeDeps } from './authorize.js';

/** Everything needed to check and repair one user's device, as plain data. */
export interface RepairTask {
  /** Full NetSapiens domain (with territory suffix). */
  domain: string;
  /** Base extension, e.g. "100". */
  ext: string;
  /** Expected device name, `<ext><suffix>`. */
  device: string;
  /** Ringotel org id holding the record. */
  orgid: string;
  /** Ringotel user id to update if the device is recreated. */
  userId: string;
  /** The record's CURRENT authname — repair is refused unless it equals `device`. */
  authname: string;
}

export async function runDeviceRepair(task: RepairTask, deps: AuthorizeDeps): Promise<Record<string, unknown>> {
  const log: Record<string, unknown> = {
    housekeeping: 'device-check',
    domain: task.domain,
    ext: task.ext,
    device: task.device,
  };

  if (task.authname !== task.device) {
    return { ...log, result: 'skipped-authname-drift', authname: task.authname };
  }

  try {
    const { rt, ns } = await deps.getWrite();

    const devices = await ns.getDevices(task.domain, task.ext);
    if (devices.some((d) => String(d.device ?? '') === task.device)) {
      return { ...log, result: 'ok' };
    }

    // Recreating mints a NEW SIP password, so pushing it to Ringotel is not optional — half of this
    // repair leaves the record definitively stale rather than merely broken.
    const created = await ns.createDevice(task.domain, task.ext, task.device);
    const password = String(created[SIP_PW_FIELD] ?? '');
    if (!password) return { ...log, result: 'device-recreated-no-password' };

    await rt.updateUser(task.userId, task.orgid, { password });
    return { ...log, result: 'device-recreated' };
  } catch (e) {
    return { ...log, result: 'error', error: String((e as Error).message) };
  }
}
