import { sendRaw, subscribeScreenshotDecorations } from '@src/browser-control';
import { settingsStorage } from '@src/store/settings';
import { pageCursor } from '@src/extension/cursor';
import { FIXTURE_ORIGIN } from '../fixtures-config';
import { attach } from '../spike-session';
import { assert, evaluate, sleep, withTab } from './helpers';
import { defineCheck } from './registry';

async function cursorState(tabId: number) {
  const [value] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const host = document.querySelector<HTMLElement>('[data-nanobrowser-cursor]');
      return host
        ? {
            visible: host.style.display !== 'none',
            closed: host.shadowRoot === null,
            inert: host.style.pointerEvents === 'none',
            hiddenFromAx: host.getAttribute('aria-hidden') === 'true',
          }
        : null;
    },
  });
  return value.result;
}

defineCheck({
  name: 'virtual-mouse',
  title: 'Virtual mouse follows real input',
  description:
    'Real trusted CDP mouse events, a non-interactive closed-shadow overlay, screenshot hiding and Stop cleanup.',
  async run() {
    const settings = await settingsStorage.get();
    await settingsStorage.set({ ...settings!, virtualMouse: true });
    try {
      return await withTab(`${FIXTURE_ORIGIN}/virtual-mouse.html`, async tab => {
        await attach(tab.tabId);
        const mouse = (type: string, x: number, y: number, buttons = 0) =>
          sendRaw(tab.tabId, undefined, 'Input.dispatchMouseEvent', {
            type,
            x,
            y,
            buttons,
            button: type === 'mouseMoved' ? 'none' : 'left',
            clickCount: 1,
          });
        await mouse('mouseMoved', 180, 130);
        await mouse('mousePressed', 180, 130, 1);
        await mouse('mouseReleased', 180, 130);
        await mouse('mouseMoved', 500, 200);
        await sleep(200);
        const visible = await cursorState(tab.tabId);
        assert(
          visible?.visible && visible.closed && visible.inert && visible.hiddenFromAx,
          `cursor is visible, in a closed shadow root, inaccessible to hit tests and accessibility: ${JSON.stringify(visible)}`,
        );
        // Evidence of the decoration itself: this channel does not hide it, unlike the screenshot subscription.
        const decorated = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const events = await evaluate<Array<{ type: string; trusted: boolean; buttons: number }>>(
          tab.tabId,
          undefined,
          'window.inputEvents',
        );
        assert(
          events.some(e => e.type === 'click' && e.trusted),
          'the underlying page receives a trusted click',
        );
        assert(
          events.some(e => e.type === 'mousedown' && e.buttons === 1),
          'pressed button state reaches the page',
        );
        let hiddenDuringCapture = false;
        const unsubscribe = subscribeScreenshotDecorations(async tabId => {
          if (tabId === tab.tabId) hiddenDuringCapture = (await cursorState(tabId))?.visible === false;
          return async () => undefined;
        });
        let image: { data: string };
        try {
          image = await sendRaw(tab.tabId, undefined, 'Page.captureScreenshot', { format: 'png' });
        } finally {
          unsubscribe();
        }
        assert(hiddenDuringCapture, 'the raw screenshot channel hides the cursor before capture');
        assert((await cursorState(tab.tabId))?.visible, 'the cursor is restored after capture');
        await pageCursor.clear(tab.tabId);
        assert((await cursorState(tab.tabId)) === null, 'Stop clears the cursor');
        return {
          trustedInput: events,
          hiddenDuringCapture,
          removedAfterStop: true,
          image: `data:image/png;base64,${image.data}`,
          decorated,
        };
      });
    } finally {
      if (settings) await settingsStorage.set(settings);
    }
  },
});
