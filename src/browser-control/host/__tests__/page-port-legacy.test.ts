import { afterEach, describe, expect, it, vi } from 'vitest';
import { PuppeteerPagePort } from '../page-port';
import type { CdpPort } from '../../core/ports';
import type { Page } from '../puppeteer';

function setup(
  options: {
    previous?: object | null;
    content?: { width: number; height: number };
    failOverride?: boolean;
    failRestore?: boolean;
    zoom?: number;
  } = {},
) {
  vi.stubGlobal('navigator', { userAgent: 'Chromium/80.0.3987.149' });
  const previous =
    options.previous === undefined ? { width: 800, height: 600, deviceScaleFactor: 2 } : options.previous;
  const setViewport = options.failRestore
    ? vi.fn(async () => {
        throw new Error('Restore failed');
      })
    : vi.fn(async () => undefined);
  const send = vi.fn(async (_session: string | undefined, method: string) => {
    if (method === 'Page.getLayoutMetrics')
      return {
        cssContentSize: options.content ?? { width: 1200, height: 3000 },
        cssLayoutViewport: { pageX: 20, pageY: 100 },
        visualViewport: { zoom: options.zoom ?? 1 },
      };
    if (method === 'Emulation.setDeviceMetricsOverride' && options.failOverride) throw new Error('Override failed');
    return {};
  });
  const page = { viewport: () => previous, setViewport };
  const cdp = { tabId: 7, send } as unknown as CdpPort;
  const port = new PuppeteerPagePort(page as unknown as Page, cdp);
  return { port, send, setViewport, previous };
}

afterEach(() => vi.unstubAllGlobals());

describe('legacy screenshot viewport preparation', () => {
  it('converts the temporary CSS viewport to DIPs at browser zoom without narrowing its layout', async () => {
    const { port, send } = setup({ zoom: 1.25 });
    const prepared = await port.prepareScreenshot({ fullPage: true }, { width: 800, height: 600 });
    expect(send).toHaveBeenCalledWith(undefined, 'Emulation.setDeviceMetricsOverride', {
      mobile: false,
      width: 1500,
      height: 3750,
      deviceScaleFactor: 0,
    });
    await prepared.restore();
  });
  it('keeps full-page layout in place until the caller finishes masking, then restores the exact previous viewport', async () => {
    const { port, send, setViewport, previous } = setup();
    const prepared = await port.prepareScreenshot({ fullPage: true }, { width: 800, height: 600 });
    expect(prepared.changed).toBe(true);
    expect(prepared.capture).toEqual({ method: 'viewport-override', pageMayHaveReacted: true, restored: false });
    expect(send).toHaveBeenCalledWith(undefined, 'Emulation.setDeviceMetricsOverride', {
      mobile: false,
      width: 1200,
      height: 3000,
      deviceScaleFactor: 0,
    });
    expect(setViewport).not.toHaveBeenCalled();
    await prepared.restore();
    expect(setViewport).toHaveBeenCalledExactlyOnceWith(previous);
    expect(prepared.capture.restored).toBe(true);
  });

  it('clears temporary device metrics when Puppeteer had no viewport override', async () => {
    const { port, send, setViewport } = setup({ previous: null });
    const prepared = await port.prepareScreenshot({ fullPage: true }, { width: 800, height: 600 });
    await prepared.restore();
    expect(setViewport).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(undefined, 'Emulation.clearDeviceMetricsOverride');
    expect(prepared.capture.restored).toBe(true);
  });

  it('restores even when setting the temporary override rejects', async () => {
    const { port, setViewport, previous } = setup({ failOverride: true });
    await expect(port.prepareScreenshot({ fullPage: true }, { width: 800, height: 600 })).rejects.toThrow(
      'Override failed',
    );
    expect(setViewport).toHaveBeenCalledExactlyOnceWith(previous);
  });

  it('never claims restoration if the previous viewport cannot be restored', async () => {
    const { port } = setup({ failRestore: true });
    const prepared = await port.prepareScreenshot({ fullPage: true }, { width: 800, height: 600 });
    await expect(prepared.restore()).rejects.toThrow('Restore failed');
    expect(prepared.capture.restored).toBe(false);
  });

  it('does not resize a regular viewport capture or a crop entirely inside the visible viewport', async () => {
    const { port, send } = setup();
    expect((await port.prepareScreenshot({}, { width: 800, height: 600 })).changed).toBe(false);
    const clip = { x: 20, y: 100, width: 800, height: 600 };
    expect((await port.prepareScreenshot({ clip }, { width: 800, height: 600 })).changed).toBe(false);
    expect(send.mock.calls.filter(([, method]) => method.startsWith('Emulation.'))).toHaveLength(0);
  });

  it('refuses oversized full-page layouts before changing device metrics', async () => {
    const { port, send } = setup({ content: { width: 10_000, height: 10_000 } });
    await expect(port.prepareScreenshot({ fullPage: true }, { width: 800, height: 600 })).rejects.toThrow(
      'capture budget',
    );
    expect(send.mock.calls.filter(([, method]) => method.startsWith('Emulation.'))).toHaveLength(0);
  });

  it('leaves modern full-page screenshots on the native path', async () => {
    const { port, send } = setup();
    vi.stubGlobal('navigator', { userAgent: 'Chrome/125.0.0.0' });
    const prepared = await port.prepareScreenshot({ fullPage: true }, { width: 800, height: 600 });
    expect(prepared.capture).toEqual({ method: 'native', pageMayHaveReacted: false, restored: true });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('screenshot clip units under browser zoom', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  function shotSetup(userAgent: string, zoom: number) {
    vi.stubGlobal('navigator', { userAgent });
    const send = vi.fn(async (_session: string | undefined, method: string, _params?: object, _timeoutMs?: number) => {
      if (method === 'Page.getLayoutMetrics')
        return {
          cssContentSize: { width: 1000, height: 2000 },
          cssLayoutViewport: { pageX: 0, pageY: 0 },
          visualViewport: { zoom },
        };
      if (method === 'Page.captureScreenshot') return { data: PNG };
      return {};
    });
    const port = new PuppeteerPagePort({} as Page, { tabId: 1, send } as unknown as CdpPort);
    return { port, send };
  }
  const paramsOf = (send: ReturnType<typeof shotSetup>['send']) =>
    send.mock.calls.find(([, method]) => method === 'Page.captureScreenshot')![2] as {
      clip: { x: number; y: number; width: number; height: number };
      captureBeyondViewport?: boolean;
    };

  it('scales a full-page clip for Chrome 125+, which takes page-zoomed pixels', async () => {
    const { port, send } = shotSetup('Chrome/125.0.0.0', 1.25);
    await port.screenshot({ fullPage: true });
    expect(paramsOf(send).clip).toEqual({ x: 0, y: 0, width: 1250, height: 2500, scale: 1 });
    expect(paramsOf(send).captureBeyondViewport).toBe(true);
  });

  it('scales a crop for Chrome 125+, so the clip stays on the referenced element', async () => {
    const { port, send } = shotSetup('Chrome/125.0.0.0', 1.25);
    await port.screenshot({ clip: { x: 10, y: 20, width: 100, height: 50 } });
    expect(paramsOf(send).clip).toEqual({ x: 12.5, y: 25, width: 125, height: 62.5, scale: 1 });
  });

  it('leaves CSS clip coordinates to Chrome 80, which applies page zoom itself', async () => {
    const { port, send } = shotSetup('Chromium/80.0.3987.149', 1.25);
    await port.screenshot({ clip: { x: 10, y: 20, width: 100, height: 50 } });
    expect(paramsOf(send).clip).toEqual({ x: 10, y: 20, width: 100, height: 50, scale: 1 });
    expect(paramsOf(send).captureBeyondViewport).toBeUndefined();
  });
});
