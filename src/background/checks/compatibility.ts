import type { ScreenshotData } from '@src/browser-control';
import { FIXTURE_ORIGIN } from '../fixtures-config';
import { layer } from '../layer';
import { attach } from '../spike-session';
import { defineCheck } from './registry';
import { assert, evaluate, sleep, withTab } from './helpers';

defineCheck({
  name: 'compatibility-diagnostics',
  title: 'Browser compatibility diagnostics',
  description: 'Records the actual browser, old and normalized layout metrics, frame identities and capture results.',
  async run(args) {
    return withTab(`${FIXTURE_ORIGIN}/${args.page === 'form.html' ? 'form.html' : 'compatibility.html'}`, async tab => {
      if (args.zoom) await chrome.tabs.setZoom(tab.tabId, Number(args.zoom));
      const a = await attach(tab.tabId);
      await sleep(300);
      const { session } = await layer();
      const snapshot = await session.call('snapshot', { tabId: tab.tabId });
      const frames = await a.topology.frames();
      const screenshots: Record<string, unknown> = {};
      for (const fullPage of [false, true]) {
        const result = await session.call('screenshot', { tabId: tab.tabId, fullPage });
        const data = result.data as ScreenshotData | undefined;
        screenshots[fullPage ? 'full' : 'viewport'] = data
          ? {
              width: data.width,
              height: data.height,
              scale: data.scale,
              bottom: await pixel(data, data.width / 2, data.height - 30),
            }
          : { error: result.text };
      }
      return {
        userAgent: navigator.userAgent,
        rawMetrics: await chrome.debugger.sendCommand({ tabId: tab.tabId }, 'Page.getLayoutMetrics'),
        metrics: await a.cdp.send(undefined, 'Page.getLayoutMetrics'),
        page: await evaluate(
          tab.tabId,
          undefined,
          '({innerWidth,innerHeight,dpr:devicePixelRatio,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth})',
        ),
        frames,
        snapshot: snapshot.text,
        screenshots,
      };
    });
  },
});

async function pixel(data: ScreenshotData, x: number, y: number): Promise<number[]> {
  const image = await createImageBitmap(
    new Blob([Uint8Array.from(atob(data.base64), c => c.charCodeAt(0))], { type: 'image/png' }),
  );
  try {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data);
  } finally {
    image.close();
  }
}

defineCheck({
  name: 'compatibility',
  title: 'Core browser compatibility',
  description:
    'Real snapshot, same-process and cross-process refs, trusted clicks, input, scrolling and full screenshot pixels.',
  async run(args) {
    return withTab(`${FIXTURE_ORIGIN}/compatibility.html`, async tab => {
      if (args.zoom) await chrome.tabs.setZoom(tab.tabId, Number(args.zoom));
      const attachment = await attach(tab.tabId);
      await sleep(300);
      const { session } = await layer();
      const snapshot = await session.call('snapshot', { tabId: tab.tabId, window: 'page' });
      assert(snapshot.ok, snapshot.text);
      assert(!JSON.stringify(snapshot).includes('compat-secret'), 'snapshot masks the password');
      const refs = (snapshot.page?.snapshot ?? '')
        .split('\n')
        .filter(line => /\[[^\]]+\] button "Inner action"/.test(line));
      assert(refs.length === 2, `both inner frames are observed once: ${refs.join('; ')}`);
      for (let nth = 0; nth < 2; nth++) {
        const ref = refs[nth].match(/\[([^\]]+)\]/)?.[1];
        assert(ref, `frame ${nth} has a shown browser ref`);
        const inner = await session.call('click', { tabId: tab.tabId, target: { ref }, observe: 'none' });
        assert(inner.ok, `inner frame ${nth}: ${inner.text}`);
      }
      const sameOrigin = await evaluate(
        tab.tabId,
        undefined,
        'document.querySelector("iframe").contentDocument.getElementById("status").textContent',
      );
      const crossFrame = (await attachment.topology.frames()).find(frame => frame.url.includes('127.0.0.1'));
      assert(crossFrame?.sessionId, 'the cross-origin frame has its own session');
      const crossOrigin = await evaluate(
        tab.tabId,
        crossFrame.sessionId,
        'document.getElementById("status").textContent',
      );
      assert(
        sameOrigin === 'Trusted action' && crossOrigin === 'Trusted action',
        'trusted input reaches the exact node in each frame',
      );
      const click = await session.call('click', { tabId: tab.tabId, target: { role: 'button', name: 'Increment' } });
      assert(click.ok, click.text);
      const state = await evaluate<{ count: string; trusted: boolean }>(
        tab.tabId,
        undefined,
        '({count:document.getElementById("count").textContent,trusted:window.events[0].trusted})',
      );
      assert(state.count === '1' && state.trusted, 'click reaches the real target with trusted input');
      const fill = await session.call('set', {
        tabId: tab.tabId,
        target: { role: 'textbox', name: 'Full name' },
        value: 'Grace',
      });
      assert(fill.ok, fill.text);
      assert(
        (await evaluate(tab.tabId, undefined, 'document.getElementById("name").value')) === 'Grace',
        'input is set',
      );
      const scrolled = await session.call('scroll', { tabId: tab.tabId, to: 'bottom', observe: 'none' });
      assert(scrolled.ok, scrolled.text);
      assert(Number(await evaluate(tab.tabId, undefined, 'scrollY')) > 1000, 'real scrolling reaches the lower page');
      const before = await evaluate(tab.tabId, undefined, '({x:scrollX,y:scrollY,w:innerWidth,h:innerHeight})');
      const shot = await session.call('screenshot', { tabId: tab.tabId, fullPage: true });
      assert(shot.ok, shot.text);
      const data = shot.data as ScreenshotData;
      const bottom = await pixel(data, data.width / 2, data.height - 30);
      assert(
        bottom[0] > 180 && bottom[1] < 50 && bottom[2] < 50,
        `full screenshot includes bottom sentinel: ${bottom}`,
      );
      const after = await evaluate(tab.tabId, undefined, '({x:scrollX,y:scrollY,w:innerWidth,h:innerHeight})');
      assert(JSON.stringify(before) === JSON.stringify(after), 'capture restores viewport and scroll');
      return {
        userAgent: navigator.userAgent,
        state,
        frames: { sameOrigin, crossOrigin },
        before,
        after,
        screenshot: { width: data.width, height: data.height, bottom, capture: data.capture },
      };
    });
  },
});
