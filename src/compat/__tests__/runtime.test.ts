import { afterEach, describe, expect, it, vi } from 'vitest';
import { clone, installRuntimeCompatibility } from '../runtime';
import { installChromeCompatibility } from '../bootstrap';

const originals = new Map<string, PropertyDescriptor | undefined>();
function removeGlobal(name: string) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Reflect.deleteProperty(globalThis, name);
}
afterEach(() => {
  originals.forEach((descriptor, key) => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
  originals.clear();
});

describe('Chromium 80 runtime compatibility', () => {
  it('clones cycles, shared buffers, maps and sets without retaining the original objects', () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const source = {
      buffer,
      view: new Uint8Array(buffer),
      map: new Map([['x', new Set([1, 2])]]),
      self: null as unknown,
    };
    source.self = source;
    const result = clone(source);
    expect(result).not.toBe(source);
    expect(result.self).toBe(result);
    expect(result.buffer).not.toBe(buffer);
    expect(result.view.buffer).toBe(result.buffer);
    expect(result.map.get('x')).toEqual(new Set([1, 2]));
    expect(() => clone(() => 1)).toThrow(/cannot be cloned/);
    expect(() => clone(buffer, { transfer: [buffer] })).toThrow(/not supported/);
  });

  it('decodes split multibyte provider chunks and flushes the stream', async () => {
    removeGlobal('TextDecoderStream');
    installRuntimeCompatibility();
    const bytes = new TextEncoder().encode('你好世界');
    const stream = new ReadableStream<BufferSource>({
      start(c) {
        c.enqueue(bytes.slice(0, 2));
        c.enqueue(bytes.slice(2, 7));
        c.enqueue(bytes.slice(7));
        c.close();
      },
    });
    const decoded = stream.pipeThrough(new TextDecoderStream());
    expect(await new Response(decoded.pipeThrough(new TextEncoderStream())).text()).toBe('你好世界');
  });

  it('preserves surrogate pairs across encoder chunks', async () => {
    removeGlobal('TextEncoderStream');
    installRuntimeCompatibility();
    const input = new ReadableStream<string>({
      start(c) {
        c.enqueue('\ud83d');
        c.enqueue('\ude00');
        c.close();
      },
    });
    expect(await new Response(input.pipeThrough(new TextEncoderStream())).text()).toBe('😀');
  });
});

describe('Chrome callback compatibility', () => {
  it('preserves the one-argument, user-gesture call to legacy downloads.open without adding a callback', async () => {
    const open = vi.fn((...args: unknown[]) => {
      if (args.length !== 1) throw new Error('No matching signature');
    });
    const api = {
      runtime: { getManifest: () => ({ manifest_version: 2 }) },
      downloads: { open },
      storage: { session: {} },
      sidePanel: { __nbLegacy: true },
      scripting: {},
    } as unknown as typeof chrome;
    installChromeCompatibility(api);
    await api.downloads.open(7);
    expect(open).toHaveBeenCalledWith(7);
    installChromeCompatibility(api);
    await api.downloads.open(8);
    expect(open).toHaveBeenLastCalledWith(8);
  });
  it('turns callback results and runtime.lastError into fulfilled and rejected promises', async () => {
    const api = {
      runtime: {
        id: 'test',
        getManifest: () => ({ manifest_version: 3 }),
        lastError: undefined as { message: string } | undefined,
      },
      tabs: {
        get: vi.fn((id: number, callback: (value?: { id: number }) => void) => {
          if (id < 0) api.runtime.lastError = { message: 'No tab' };
          callback(id >= 0 ? { id } : undefined);
          api.runtime.lastError = undefined;
        }),
      },
      commands: { getAll: vi.fn((callback: (commands: unknown[]) => void) => callback([{ name: 'open-panel' }])) },
      action: { getUserSettings: vi.fn((callback: (settings: object) => void) => callback({ isOnToolbar: true })) },
      storage: { local: {}, sync: {}, session: {} },
      sidePanel: { __nbLegacy: true },
      scripting: {},
    };
    installChromeCompatibility(api as unknown as typeof chrome);
    const get = api.tabs.get as unknown as (id: number) => Promise<{ id: number }>;
    await expect(get(7)).resolves.toEqual({ id: 7 });
    const extension = api as unknown as typeof chrome;
    await expect(extension.commands.getAll()).resolves.toEqual([{ name: 'open-panel' }]);
    await expect(extension.action.getUserSettings()).resolves.toEqual({ isOnToolbar: true });
    await expect(get(-1)).rejects.toThrow('No tab');
    const callback = vi.fn();
    api.tabs.get(8, callback);
    expect(callback).toHaveBeenCalledWith({ id: 8 });
    installChromeCompatibility(api as unknown as typeof chrome);
    await expect(get(9)).resolves.toEqual({ id: 9 });
  });
});
