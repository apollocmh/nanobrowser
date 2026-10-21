import { describe, expect, it, vi } from 'vitest';
import { installChromeCompatibility } from '../bootstrap';

function event() {
  const callbacks = new Set<(...args: unknown[]) => unknown>();
  return {
    addListener: vi.fn((fn: (...args: unknown[]) => unknown) => callbacks.add(fn)),
    removeListener: vi.fn((fn: (...args: unknown[]) => unknown) => callbacks.delete(fn)),
    fire: (...args: unknown[]) => callbacks.forEach(fn => fn(...args)),
  };
}

function apiFor(owner: object) {
  return {
    runtime: { id: 'extension', getManifest: () => ({ manifest_version: 2 }), onMessage: event() },
    extension: { getBackgroundPage: () => owner },
    tabs: {},
    storage: { local: {}, sync: {}, onChanged: event() },
    scripting: {},
    sidePanel: { __nbLegacy: true },
  } as unknown as typeof chrome;
}

describe('MV2 session storage', () => {
  it('shares disposable state across windows and remains usable after permission changes', async () => {
    const background = {};
    const a = apiFor(background);
    const b = apiFor(background);
    installChromeCompatibility(a);
    installChromeCompatibility(b);
    const changed = vi.fn();
    b.storage.onChanged.addListener(changed);
    const source = { selected: [7] };
    await a.storage.session.set({ scope: source });
    source.selected.push(99);
    expect(await b.storage.session.get('scope')).toEqual({ scope: { selected: [7] } });
    expect(changed).toHaveBeenCalledWith({ scope: { oldValue: undefined, newValue: { selected: [7] } } }, 'session');
    installChromeCompatibility(a);
    await a.storage.session.set({ another: 1 });
    expect(await a.storage.session.get(['another'])).toEqual({ another: 1 });
    await b.storage.session.remove('scope');
    expect(await a.storage.session.get({ scope: 'fallback' })).toEqual({ scope: 'fallback' });
    const restarted = apiFor({});
    installChromeCompatibility(restarted);
    expect(await restarted.storage.session.get(null)).toEqual({});
  });
});
