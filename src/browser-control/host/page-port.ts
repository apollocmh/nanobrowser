// Puppeteer's remaining jobs: keyboard input with its key definitions, navigation with load waits.
// Screenshots are taken with a raw Page.captureScreenshot, which leaves the viewport untouched.
import type { CdpPort, PagePort, ScreenshotCapture, ScreenshotOptions } from '../core/ports';
import { LayerError } from '../protocol/errors';
import { splitChord } from '../core/interaction/keys';
import { quote } from '../core/text';
import { isKnownKey } from './puppeteer';
import type { KeyInput, Page } from './puppeteer';
import { browserMajor } from './legacy-cdp';

const MODIFIERS = new Set(['Alt', 'Control', 'Meta', 'Shift', 'ControlOrMeta']);

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(base64: string): { width: number; height: number } {
  const header = atob(base64.slice(0, 44));
  const read = (offset: number) =>
    ((header.charCodeAt(offset) << 24) |
      (header.charCodeAt(offset + 1) << 16) |
      (header.charCodeAt(offset + 2) << 8) |
      header.charCodeAt(offset + 3)) >>>
    0;
  return { width: read(16), height: read(20) };
}

export class PuppeteerPagePort implements PagePort {
  constructor(
    private readonly page: Page,
    private readonly cdp: CdpPort,
  ) {}

  async prepareScreenshot(options: ScreenshotOptions, viewport: { width: number; height: number }) {
    const capture: ScreenshotCapture = { method: 'native', pageMayHaveReacted: false, restored: true };
    if (browserMajor() >= 90 || (!options.fullPage && !options.clip))
      return { changed: false, capture, restore: async () => {} };
    const metrics = await this.cdp.send<{
      cssContentSize: { width: number; height: number };
      cssLayoutViewport: { pageX: number; pageY: number };
      visualViewport?: { zoom?: number };
    }>(undefined, 'Page.getLayoutMetrics');
    const clip = options.clip;
    if (
      clip &&
      clip.x >= metrics.cssLayoutViewport.pageX &&
      clip.y >= metrics.cssLayoutViewport.pageY &&
      clip.x + clip.width <= metrics.cssLayoutViewport.pageX + viewport.width &&
      clip.y + clip.height <= metrics.cssLayoutViewport.pageY + viewport.height
    )
      return { changed: false, capture, restore: async () => {} };
    const width = Math.ceil(Math.max(viewport.width, metrics.cssContentSize.width));
    const height = Math.ceil(Math.max(viewport.height, metrics.cssContentSize.height));
    if (width > 32767 || height > 32767 || width * height > 64_000_000)
      throw new LayerError(
        'CAPTURE_FAILED',
        'Full-page screenshot exceeds the 64 million CSS pixel capture budget. Nothing was captured.',
      );
    const previous = this.page.viewport();
    const zoom = metrics.visualViewport?.zoom ?? 1;
    capture.method = 'viewport-override';
    capture.pageMayHaveReacted = true;
    capture.restored = false;
    const restore = async () => {
      if (previous) await this.page.setViewport(previous);
      else await this.cdp.send(undefined, 'Emulation.clearDeviceMetricsOverride');
      capture.restored = true;
    };
    try {
      await this.cdp.send(undefined, 'Emulation.setDeviceMetricsOverride', {
        mobile: false,
        width: Math.ceil(width * zoom),
        height: Math.ceil(height * zoom),
        deviceScaleFactor: 0,
      });
    } catch (error) {
      await restore();
      throw error;
    }
    return { changed: true, capture, restore };
  }

  async screenshot(options: ScreenshotOptions) {
    const params: Record<string, unknown> = { format: 'png' };
    if (options.clip || options.fullPage) {
      const metrics = await this.cdp.send<{
        cssContentSize: { width: number; height: number };
        visualViewport?: { zoom?: number };
      }>(undefined, 'Page.getLayoutMetrics');
      const clip = options.clip ?? {
        x: 0,
        y: 0,
        width: metrics.cssContentSize.width,
        height: metrics.cssContentSize.height,
      };
      // Chrome 125+ takes a page-zoomed clip: with browser zoom 1.25, a CSS-sized clip captures only the
      // top-left 1/1.25 of the page. Older Chrome applies the zoom itself, so it keeps CSS coordinates.
      const zoom = browserMajor() >= 125 ? (metrics.visualViewport?.zoom ?? 1) : 1;
      params.clip = {
        x: clip.x * zoom,
        y: clip.y * zoom,
        width: clip.width * zoom,
        height: clip.height * zoom,
        scale: 1,
      };
      if (browserMajor() >= 90) params.captureBeyondViewport = true;
    }
    const { data } = await this.cdp.send<{ data: string }>(undefined, 'Page.captureScreenshot', params, 20_000);
    return { base64: data, ...pngSize(data) };
  }

  /** A chord such as "Control+A": the same split as the gate's (core/interaction/keys.ts), modifiers mapped. */
  chord(keys: string): { modifiers: string[]; key: string } {
    const { modifiers: parts, key } = splitChord(keys);
    const isMac = /Mac/i.test(navigator.userAgent);
    const modifiers = parts.map(m => (m === 'ControlOrMeta' ? (isMac ? 'Meta' : 'Control') : m));
    for (const modifier of modifiers) {
      if (!MODIFIERS.has(modifier)) throw new LayerError('INVALID_ARGUMENT', `Unknown modifier "${modifier}"`);
    }
    if (!isKnownKey(key)) throw new LayerError('INVALID_ARGUMENT', `Unknown key ${quote(key, 40)}`);
    return { modifiers, key };
  }

  async keyDown(key: string): Promise<void> {
    await this.page.keyboard.down(key as KeyInput);
  }

  async keyUp(key: string): Promise<void> {
    await this.page.keyboard.up(key as KeyInput);
  }

  isKey(char: string): boolean {
    return isKnownKey(char);
  }

  async insertCharacter(char: string): Promise<void> {
    await this.page.keyboard.sendCharacter(char);
  }

  async goto(url: string, timeoutMs: number): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  async goBack(timeoutMs: number): Promise<void> {
    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  async goForward(timeoutMs: number): Promise<void> {
    await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  async reload(timeoutMs: number): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }
}
