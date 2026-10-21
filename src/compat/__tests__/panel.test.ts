import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLegacyPanel } from '../panel';

function event<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => listeners.add(listener),
    fire: (...args: Parameters<T>) => listeners.forEach(listener => listener(...args)),
  };
}

function setup(owner: object = {}) {
  const removed = event<(windowId: number) => void>();
  const tabsRemoved = event<(tabId: number) => void>();
  let nextWindow = 20;
  const api = {
    runtime: {
      getManifest: () => ({ manifest_version: 2 }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      lastError: undefined as { message: string } | undefined,
    },
    extension: { getBackgroundPage: () => owner },
    tabs: { get: vi.fn(async (id: number) => ({ id })), onRemoved: tabsRemoved },
    windows: {
      create: vi.fn(async () => ({ id: nextWindow++ })),
      // Like Chromium 80, a closing window can still accept focus updates.
      update: vi.fn(async (id: number) => ({ id })),
      remove: vi.fn(async (_id: number, callback?: () => void) => {
        callback?.();
      }),
      onRemoved: removed,
    },
    sidePanel: undefined,
  };
  const nativeRemove = api.windows.remove;
  installLegacyPanel(api as unknown as typeof chrome);
  const chromeApi = api as unknown as typeof chrome;
  return { api, chromeApi, nativeRemove, removed };
}

afterEach(() => vi.useRealTimers());

describe('MV2 companion window lifecycle', () => {
  it('waits for real removal before an immediate reopen, even when native remove resolves and focus would succeed', async () => {
    const { api, chromeApi, removed } = setup();
    await chromeApi.sidePanel.open({ tabId: 3 });
    let closed = false;
    const close = chromeApi.windows.remove(20).then(() => {
      closed = true;
    });
    const reopen = chromeApi.sidePanel.open({ tabId: 3 });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(api.windows.update).not.toHaveBeenCalled();
    expect(api.windows.create).toHaveBeenCalledTimes(1);
    removed.fire(20);
    await Promise.all([close, reopen]);
    expect(api.windows.create).toHaveBeenCalledTimes(2);
    await chromeApi.sidePanel.open({ tabId: 3 });
    expect(api.windows.update).toHaveBeenCalledExactlyOnceWith(21, { focused: true });
  });

  it('restores a live window after a rejected close and preserves the native error', async () => {
    const { api, chromeApi, nativeRemove } = setup();
    await chromeApi.sidePanel.open({ tabId: 3 });
    nativeRemove.mockRejectedValueOnce(new Error('Close refused'));
    await expect(chromeApi.windows.remove(20)).rejects.toThrow('Close refused');
    await chromeApi.sidePanel.open({ tabId: 3 });
    expect(api.windows.update).toHaveBeenCalledExactlyOnceWith(20, { focused: true });
    expect(api.windows.create).toHaveBeenCalledTimes(1);
  });

  it('does not report a focused window as open when removal starts while focus is in flight', async () => {
    const { api, chromeApi, removed } = setup();
    await chromeApi.sidePanel.open({ tabId: 3 });
    let focus!: () => void;
    api.windows.update.mockImplementationOnce(
      id =>
        new Promise(resolve => {
          focus = () => resolve({ id });
        }),
    );
    const reopen = chromeApi.sidePanel.open({ tabId: 3 });
    await Promise.resolve();
    const close = chromeApi.windows.remove(20);
    focus();
    await Promise.resolve();
    expect(api.windows.create).toHaveBeenCalledTimes(1);
    removed.fire(20);
    await Promise.all([close, reopen]);
    expect(api.windows.create).toHaveBeenCalledTimes(2);
  });

  it('coalesces repeated close requests and does not redispatch native close', async () => {
    const { chromeApi, nativeRemove, removed } = setup();
    await chromeApi.sidePanel.open({ tabId: 3 });
    const a = chromeApi.windows.remove(20);
    const b = chromeApi.windows.remove(20);
    expect(nativeRemove).toHaveBeenCalledTimes(1);
    removed.fire(20);
    await Promise.all([a, b]);
  });

  it('cleans up a popup created after its target was disabled', async () => {
    const { api, chromeApi, nativeRemove } = setup();
    let created!: () => void;
    api.windows.create.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          created = () => resolve({ id: 20 });
        }),
    );
    const open = chromeApi.sidePanel.open({ tabId: 3 });
    const rejected = expect(open).rejects.toThrow('disabled while opening');
    await Promise.resolve();
    await chromeApi.sidePanel.setOptions({ tabId: 3, enabled: false });
    created();
    await rejected;
    expect(nativeRemove).toHaveBeenCalledExactlyOnceWith(20);
  });

  it('bounds a close with no onRemoved event and refuses to claim a successful reopen', async () => {
    vi.useFakeTimers();
    const { api, chromeApi, removed } = setup();
    await chromeApi.sidePanel.open({ tabId: 3 });
    const close = expect(chromeApi.windows.remove(20)).rejects.toThrow('did not finish closing');
    const open = expect(chromeApi.sidePanel.open({ tabId: 3 })).rejects.toThrow('did not finish closing');
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([close, open]);
    expect(api.windows.create).toHaveBeenCalledTimes(1);
    // A late real close releases the marker, so the next open can safely create a replacement.
    removed.fire(20);
    await chromeApi.sidePanel.open({ tabId: 3 });
    expect(api.windows.create).toHaveBeenCalledTimes(2);
  });

  it('shares the close boundary across extension contexts and installs each context only once', async () => {
    const owner = {};
    const a = setup(owner);
    const b = setup(owner);
    const original = a.chromeApi.windows.remove;
    installLegacyPanel(a.chromeApi);
    expect(a.chromeApi.windows.remove).toBe(original);
    await a.chromeApi.sidePanel.open({ tabId: 3 });
    const close = a.chromeApi.windows.remove(20);
    const reopen = b.chromeApi.sidePanel.open({ tabId: 3 });
    await Promise.resolve();
    expect(b.api.windows.create).not.toHaveBeenCalled();
    // The persistent background's event listener settles the operation for both windows.
    a.removed.fire(20);
    await Promise.all([close, reopen]);
    expect(b.api.windows.create).toHaveBeenCalledTimes(1);
    expect(b.api.windows.update).not.toHaveBeenCalled();
  });

  it('keeps explicit callback timing while open waits for the actual close event', async () => {
    const { api, chromeApi, removed } = setup();
    await chromeApi.sidePanel.open({ tabId: 3 });
    const callback = vi.fn();
    chromeApi.windows.remove(20, callback);
    expect(callback).toHaveBeenCalledOnce();
    const reopen = chromeApi.sidePanel.open({ tabId: 3 });
    await Promise.resolve();
    expect(api.windows.create).toHaveBeenCalledTimes(1);
    removed.fire(20);
    await reopen;
    expect(api.windows.create).toHaveBeenCalledTimes(2);
  });

  it('closes only the popup belonging to a removed target tab', async () => {
    const { api, chromeApi, removed } = setup();
    await chromeApi.sidePanel.open({ tabId: 3 });
    await chromeApi.sidePanel.open({ tabId: 4 });
    const disabled = chromeApi.sidePanel.setOptions({ tabId: 3, enabled: false });
    removed.fire(20);
    await disabled;
    await chromeApi.sidePanel.open({ tabId: 4 });
    expect(api.windows.update).toHaveBeenCalledExactlyOnceWith(21, { focused: true });
  });
});
