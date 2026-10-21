// Only trusted CDP input changes fixture state. Runtime.evaluate below reads business state and event receipts.
import type { Session } from '@src/browser-control';
import { FIXTURE_ORIGIN } from '../fixtures-config';
import { layer } from '../layer';
import { openTab } from '../tabs';
import { defineCheck } from './registry';
import { assert, evaluate, sleep, waitForLoad } from './helpers';

interface PointerRecord {
  scope: string;
  type: string;
  trusted: boolean;
  buttons: number;
}
interface ControlsState {
  events: PointerRecord[];
  svg: { x: number; commits: number };
  shadow: { value: number; commits: number };
  scroll: { x: number; commits: number };
  frame: { x: number; commits: number };
  recovery: { x: number; commits: number; clicks: number };
}

function trace(stage: string): void {
  const url = import.meta.env.WXT_AUTORUN_URL as string | undefined;
  if (url)
    void fetch(`${url}/__autorun/trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check: 'gesture-controls', stage }),
    }).catch(() => undefined);
}

async function runTool(session: Session, tool: string, args: Record<string, unknown> = {}) {
  trace(tool);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Gesture control step ${tool} exceeded 20000 ms`);
      abort.abort(error);
      reject(error);
    }, 20_000);
  });
  try {
    const result = await Promise.race([
      session.call(tool, { ...(tool === 'snapshot' ? {} : { observe: 'none' }), ...args }, { signal: abort.signal }),
      timeout,
    ]);
    assert(result.ok, `${tool}: ${result.error?.code}: ${result.error?.message}`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function assertSequence(events: PointerRecord[], scope: string): void {
  const records = events.filter(event => event.scope === scope);
  assert(records.length > 0 && records.every(event => event.trusted), `${scope} received only real trusted input`);
  const down = records.findIndex(event => event.type === 'pointerdown' && event.buttons === 1);
  const move = records.findIndex((event, index) => index > down && event.type === 'pointermove' && event.buttons === 1);
  const up = records.findIndex((event, index) => index > move && event.type === 'pointerup' && event.buttons === 0);
  assert(down >= 0 && move > down && up > move, `${scope} received press 1, held movement 1, release 0 in order`);
}

defineCheck({
  name: 'gesture-controls',
  title: 'SVG, closed shadow, scrolled and framed pointer gestures',
  description:
    'Asserts real custom control movement and trusted pointer/button sequences, then checks timeout, navigation and debugger-detach cancellation followed by clean input.',
  async run() {
    const { controller } = await layer();
    const tab = await openTab(`${FIXTURE_ORIGIN}/gesture-controls.html`);
    const tabId = tab.id!;
    const session = controller.createSession({ confirm: 'sensitive', observeDefault: 'none' });
    session.shareTab(tabId);
    const button = (name: string) => ({ role: 'button', name });
    const recovery = button('Recovery workspace');
    const state = () => evaluate<ControlsState>(tabId, undefined, 'JSON.parse(JSON.stringify(window.gestureControls))');
    const snapshot = () => runTool(session, 'snapshot', { mode: 'all', window: 'page' });
    const staleStep = async (gestureId: string, reason: string) => {
      const before = (await state()).events.length;
      const result = await session.call('mouse_up', { gestureId, target: recovery, observe: 'none', timeoutMs: 2000 });
      assert(!result.ok, `${reason} invalidated the previous gesture ID`);
      assert(
        ['INVALID_ARGUMENT', 'CANCELLED', 'STALE_DOCUMENT', 'DEBUGGER_DETACHED'].includes(result.error?.code ?? ''),
        `${reason} returned a typed invalidation: ${result.error?.code}: ${result.error?.message}`,
      );
      const added = (await state()).events.slice(before);
      assert(!added.some(event => event.type === 'pointerup'), `${reason} never commits a stale release`);
    };
    const recovered = async (reason: string) => {
      const before = await state();
      await runTool(session, 'hover', { target: recovery });
      const hovered = await state();
      const movements = hovered.events.slice(before.events.length).filter(event => event.type === 'pointermove');
      assert(
        movements.length > 0 && movements.every(event => event.trusted && event.buttons === 0),
        `${reason} leaves no held button on subsequent real hover`,
      );
      assert(hovered.recovery.x === before.recovery.x, `${reason} does not continue moving the cancelled node`);
      await runTool(session, 'click', { target: recovery });
      const clicked = await state();
      assert(clicked.recovery.clicks === before.recovery.clicks + 1, `${reason} permits one subsequent trusted click`);
      const clicks = clicked.events.slice(hovered.events.length);
      assert(
        clicks.some(event => event.type === 'pointerdown' && event.trusted && event.buttons === 1) &&
          clicks.some(event => event.type === 'pointerup' && event.trusted && event.buttons === 0),
        `${reason} follow-up click has a complete clean button lifecycle`,
      );
    };
    try {
      await snapshot();
      await runTool(session, 'drag', {
        source: button('SVG workspace'),
        sourceOffset: { x: 0.1, y: 0.5 },
        target: button('SVG workspace'),
        offset: { x: 0.8, y: 0.5 },
        steps: 10,
        durationMs: 150,
      });
      const svg = await state();
      assert(svg.svg.x > 270 && svg.svg.commits === 1, `SVG node moved to ${svg.svg.x} and committed once`);
      const renderedX = await evaluate<number>(
        tabId,
        undefined,
        'Number(document.getElementById("svg-node").getAttribute("x"))',
      );
      assert(renderedX === svg.svg.x, 'the actual SVG rect moved, not only the reported model');
      assertSequence(svg.events, 'svg');

      await snapshot();
      const slider = { role: 'slider', name: 'Closed shadow slider' };
      await runTool(session, 'drag', {
        source: slider,
        sourceOffset: { x: 0.1, y: 0.5 },
        target: slider,
        offset: { x: 0.8, y: 0.5 },
        steps: 10,
        durationMs: 150,
      });
      const shadow = await state();
      assert(
        shadow.shadow.value >= 75 && shadow.shadow.commits === 1,
        'the closed-shadow slider changed its business value once',
      );
      assert(
        await evaluate<boolean>(tabId, undefined, 'document.getElementById("shadow-host").shadowRoot === null'),
        'the slider lives in a genuinely closed shadow root',
      );
      assertSequence(shadow.events, 'shadow');

      await snapshot();
      await runTool(session, 'scroll', { target: { role: 'region', name: 'Scroll lane' }, by: { px: 200 } });
      const scrollTop = await evaluate<number>(tabId, undefined, 'document.getElementById("scroll-lane").scrollTop');
      assert(scrollTop >= 150, `real wheel input scrolled the container to ${scrollTop}`);
      await snapshot();
      await runTool(session, 'drag', {
        source: button('Scrolled workspace'),
        sourceOffset: { x: 0.1, y: 0.5 },
        target: button('Scrolled workspace'),
        offset: { x: 0.8, y: 0.5 },
        steps: 10,
        durationMs: 150,
      });
      const scrolled = await state();
      assert(scrolled.scroll.x > 270 && scrolled.scroll.commits === 1, 'the node moved inside its scrolled container');
      assert(
        (await evaluate<number>(tabId, undefined, 'document.getElementById("scroll-lane").scrollTop')) >= 150,
        'the drag operated while the container remained scrolled',
      );
      assertSequence(scrolled.events, 'scroll');

      await snapshot();
      const frames = await controller.tabState(tabId).attachment!.topology.frames();
      const rootFrame = frames.find(frame => !frame.parentFrameId);
      const innerFrame = frames.find(frame => frame.url.includes('gesture-controls.html?frame=1'));
      assert(
        rootFrame && innerFrame && rootFrame.sessionId === innerFrame.sessionId,
        'the custom frame is actually same-process',
      );
      await runTool(session, 'drag', {
        source: button('Frame workspace'),
        sourceOffset: { x: 0.1, y: 0.5 },
        target: button('Frame workspace'),
        offset: { x: 0.8, y: 0.5 },
        steps: 10,
        durationMs: 150,
      });
      const framed = await evaluate<ControlsState>(
        tabId,
        undefined,
        'JSON.parse(JSON.stringify(document.getElementById("control-frame").contentWindow.gestureControls))',
      );
      assert(
        framed.frame.x > 270 && framed.frame.commits === 1,
        'a custom pointer gesture works inside the same-process frame',
      );
      assertSequence(framed.events, 'frame');

      await snapshot();
      const timed = await runTool(session, 'mouse_down', {
        target: recovery,
        offset: { x: 0.1, y: 0.5 },
        gestureTimeoutMs: 1000,
      });
      const timeoutBefore = await state();
      await sleep(1250);
      await staleStep((timed.data as { gestureId: string }).gestureId, '1000 ms deadline');
      assert(
        (await state()).recovery.commits === timeoutBefore.recovery.commits,
        'timeout cleanup does not commit the drag',
      );
      await recovered('1000 ms deadline');

      await snapshot();
      const navigating = await runTool(session, 'mouse_down', { target: recovery, offset: { x: 0.1, y: 0.5 } });
      const loaded = waitForLoad(tabId);
      await chrome.tabs.update(tabId, { url: `${FIXTURE_ORIGIN}/gesture-controls.html?navigation=1` });
      await loaded;
      await snapshot();
      await staleStep((navigating.data as { gestureId: string }).gestureId, 'navigation');
      assert((await state()).recovery.commits === 0, 'the new document receives no release from the old document');
      await recovered('navigation');

      await snapshot();
      const detaching = await runTool(session, 'mouse_down', { target: recovery, offset: { x: 0.1, y: 0.5 } });
      const detachBefore = await state();
      await chrome.debugger.detach({ tabId });
      await snapshot();
      await staleStep((detaching.data as { gestureId: string }).gestureId, 'debugger detach');
      assert(
        (await state()).recovery.commits === detachBefore.recovery.commits,
        'debugger detach never commits a stale release',
      );
      await recovered('debugger detach');

      const final = await state();
      assert(
        final.events.every(event => event.trusted),
        'all recorded recovery events are trusted',
      );
      return {
        browser: navigator.userAgent,
        svg: svg.svg,
        closedShadow: shadow.shadow,
        scrolled: { scrollTop, ...scrolled.scroll },
        sameProcessFrame: framed.frame,
        cancellation: { timeoutMs: 1000, navigation: true, debuggerDetach: true, followUpInputClean: true },
        recovery: final.recovery,
        events: final.events,
      };
    } finally {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          controller.closeSession(session),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Gesture controls cleanup exceeded 8000 ms')), 8000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        await chrome.tabs.remove(tabId).catch(() => undefined);
      }
    }
  },
});
