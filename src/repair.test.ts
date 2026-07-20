import { describe, it, expect, vi } from 'vitest';
import { runDeviceRepair, type RepairTask } from './repair.js';

const task: RepairTask = {
  domain: 'demo.12345.service',
  ext: '100',
  device: '100r',
  orgid: 'ORG1',
  userId: 'U1',
  authname: '100r',
};

const mkDeps = (over: {
  devices?: unknown[];
  created?: Record<string, unknown>;
  getDevices?: () => Promise<unknown[]>;
} = {}) => {
  const updateUser = vi.fn().mockResolvedValue({});
  const createDevice = vi.fn().mockResolvedValue(
    over.created ?? { 'device-sip-registration-password': 'NEWPASS' },
  );
  const getDevices = vi.fn(over.getDevices ?? (async () => over.devices ?? []));
  return {
    deps: {
      getWrite: async () => ({
        rt: { updateUser, createUser: vi.fn(), deleteUser: vi.fn() },
        ns: { getDevices, getDevice: vi.fn(), createDevice },
      }),
    } as never,
    updateUser,
    createDevice,
    getDevices,
  };
};

describe('runDeviceRepair', () => {
  it('device present → no writes, result ok', async () => {
    const { deps, updateUser, createDevice } = mkDeps({ devices: [{ device: '100r' }] });
    const log = await runDeviceRepair(task, deps);
    expect(log.result).toBe('ok');
    expect(createDevice).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('device missing → recreates it AND pushes the new password to Ringotel', async () => {
    const { deps, updateUser, createDevice } = mkDeps({ devices: [{ device: '100' }] });
    const log = await runDeviceRepair(task, deps);
    expect(createDevice).toHaveBeenCalledWith('demo.12345.service', '100', '100r');
    expect(updateUser).toHaveBeenCalledWith('U1', 'ORG1', { password: 'NEWPASS' });
    expect(log.result).toBe('device-recreated');
  });

  it('authname drift → refuses to touch anything', async () => {
    const { deps, updateUser, createDevice } = mkDeps({ devices: [] });
    const log = await runDeviceRepair({ ...task, authname: '100x' }, deps);
    expect(log.result).toBe('skipped-authname-drift');
    expect(createDevice).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('recreated device with no password → never writes a blank credential', async () => {
    const { deps, updateUser } = mkDeps({ devices: [], created: {} });
    const log = await runDeviceRepair(task, deps);
    expect(log.result).toBe('device-recreated-no-password');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('an upstream failure is reported, never thrown', async () => {
    const { deps } = mkDeps({
      getDevices: async () => {
        throw new Error('upstream exploded');
      },
    });
    const log = await runDeviceRepair(task, deps);
    expect(log.result).toBe('error');
    expect(String(log.error)).toContain('upstream exploded');
  });

  it('every outcome is tagged for log correlation', async () => {
    const { deps } = mkDeps({ devices: [{ device: '100r' }] });
    const log = await runDeviceRepair(task, deps);
    expect(log.housekeeping).toBe('device-check');
    expect(log.ext).toBe('100');
    expect(log.domain).toBe('demo.12345.service');
  });
});
