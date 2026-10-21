// This check drives real input through the extension. Page script only reads the fixture's event log and state.
import type { Session } from '@src/browser-control';
import { FIXTURE_ORIGIN } from '../fixtures-config';
import { layer } from '../layer';
import { openTab } from '../tabs';
import { defineCheck } from './registry';
import { assert, evaluate } from './helpers';

interface EventRecord {
  type: string;
  trusted: boolean;
  buttons?: number;
  target: string;
}
interface FixtureState {
  events: EventRecord[];
  nativeDrops: number;
  nodeX: number;
  nodeY: number;
  sorts: number;
  sensitiveActivations: number;
}

function trace(stage: string): void {
  console.info(`[gestures] ${stage}`);
  const url = import.meta.env.WXT_AUTORUN_URL as string | undefined;
  if (url)
    void fetch(`${url}/__autorun/trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check: 'gestures', stage }),
    }).catch(() => undefined);
}

async function runTool(session: Session, tool: string, args: Record<string, unknown>) {
  const label = (args.source ?? args.target) as { name?: string } | undefined;
  const step = `${tool}${label?.name ? ` ${label.name}` : ''}`;
  trace(`begin ${step}`);
  const start = performance.now();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`Gesture check step exceeded 15000 ms: ${step}`));
    }, 15000);
  });
  try {
    const result = await Promise.race([
      session.call(tool, { ...(tool === 'snapshot' ? {} : { observe: 'none' }), ...args }, { signal: abort.signal }),
      timeout,
    ]);
    assert(result.ok, `${step}: ${result.error?.code}: ${result.error?.message}`);
    trace(`end ${step} ${Math.round(performance.now() - start)} ms`);
    return result;
  } catch (error) {
    console.error(`[gestures] failed ${step}: ${error instanceof Error ? error.message : String(error)}`);
    trace(`failed ${step}`);
    throw error;
  } finally {
    clearTimeout(timer!);
  }
}

defineCheck({
  name: 'gestures',
  title: 'Trusted drag, staged pointer, slider, canvas and native drop',
  description:
    'Exercises actual CDP mouse input and asserts trusted events, held buttons, native HTML drop, slider value, canvas movement, sorting, cross-session exclusion and cancellation.',
  async run() {
    trace('starting');
    const { controller } = await layer();
    trace('layer ready');
    const tab = await openTab(`${FIXTURE_ORIGIN}/gestures.html`);
    trace('fixture opened');
    const session = controller.createSession({ confirm: 'sensitive', observeDefault: 'none' });
    const other = controller.createSession({ observeDefault: 'none' });
    session.shareTab(tab.id!);
    other.shareTab(tab.id!);
    const target = (name: string) => ({ role: name === 'Volume' ? 'slider' : 'button', name });
    const state = () => evaluate<FixtureState>(tab.id!, undefined, 'JSON.parse(JSON.stringify(window.gestureFixture))');
    const watchdog = setInterval(() => {
      const pending = controller
        .tabState(tab.id!)
        .pending.map(modal => modal.kind)
        .join(',');
      trace(`watchdog busy=${controller.locks.isBusy(tab.id!)} pending=${pending || 'none'}`);
    }, 2000);
    try {
      await runTool(session, 'snapshot', {});
      const slider = await runTool(session, 'drag', {
        source: target('Volume'),
        sourceOffset: { x: 0.1, y: 0.5 },
        target: target('Volume'),
        offset: { x: 0.85, y: 0.5 },
      });
      const volume = await evaluate<number>(tab.id!, undefined, 'Number(document.getElementById("slider").value)');
      assert(volume >= 70, `slider moved to ${volume}`);
      await runTool(session, 'snapshot', {});
      await runTool(session, 'drag', {
        source: target('Flow workspace'),
        sourceOffset: { x: 0.15, y: 0.4 },
        target: target('Flow workspace'),
        offset: { x: 0.75, y: 0.6 },
      });
      const canvas = await state();
      assert(canvas.nodeX > 280 && canvas.nodeY > 70, `canvas node moved to ${canvas.nodeX},${canvas.nodeY}`);
      await runTool(session, 'snapshot', {});
      await runTool(session, 'drag', { source: target('Sort A'), target: target('Sort B') });
      const order = await evaluate<string[]>(
        tab.id!,
        undefined,
        'Array.from(document.querySelectorAll("#sort li"), function(el) { return el.textContent; })',
      );
      assert(order.join(',') === 'Sort B,Sort A', `sort order ${order}`);
      await runTool(session, 'snapshot', {});
      const nativeSupported = Number(/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? 0) >= 117;
      let nativeStatus: { status: 'passed' | 'unsupported'; reason?: string };
      if (nativeSupported) {
        await runTool(session, 'drag', { source: target('Native source'), target: target('Native destination') });
        const native = await state();
        assert(native.nativeDrops === 1, `native drop count ${native.nativeDrops}`);
        await runTool(session, 'snapshot', {});
        const pressed = await runTool(session, 'mouse_down', { target: target('Native source') });
        const nativeId = (pressed.data as { gestureId: string }).gestureId;
        await runTool(session, 'mouse_move', { gestureId: nativeId, target: target('Native destination') });
        await runTool(session, 'mouse_up', { gestureId: nativeId, target: target('Native destination') });
        assert((await state()).nativeDrops === 2, 'staged native drop is trusted');
        await runTool(session, 'snapshot', {});
        const cancelled = await runTool(session, 'mouse_down', { target: target('Native source') });
        await runTool(session, 'mouse_move', {
          gestureId: (cancelled.data as { gestureId: string }).gestureId,
          target: target('Native destination'),
        });
        await session.cancelGestures();
        assert((await state()).nativeDrops === 2, 'cancelling a started native drag never commits a drop');
        await runTool(session, 'snapshot', {});
        await runTool(session, 'drag', {
          source: target('Frame native source'),
          target: target('Frame native destination'),
        });
        await runTool(session, 'snapshot', {});
        await runTool(session, 'drag', {
          source: target('Native source'),
          target: target('Frame native destination'),
        });
        const inner = await evaluate<{ nativeDrops: number; events: Array<{ trusted: boolean }> }>(
          tab.id!,
          undefined,
          'JSON.parse(JSON.stringify(document.querySelector("iframe").contentWindow.gestureFixture))',
        );
        assert(inner.nativeDrops === 2, 'native drops work inside and across frame documents');
        assert(
          inner.events.every(event => event.trusted),
          'frame native events are trusted',
        );
        await runTool(session, 'snapshot', {});
        await runTool(session, 'drag', {
          source: target('Cross native source'),
          target: target('Cross native destination'),
        });
        await runTool(session, 'snapshot', {});
        await runTool(session, 'drag', {
          source: target('Native source'),
          target: target('Cross native destination'),
        });
        const crossFrame = (await controller.tabState(tab.id!).attachment!.topology.frames()).find(frame =>
          frame.url.includes('127.0.0.1'),
        )!;
        const cross = await evaluate<{ nativeDrops: number; events: Array<{ trusted: boolean }> }>(
          tab.id!,
          crossFrame.sessionId,
          'JSON.parse(JSON.stringify(window.gestureFixture))',
        );
        assert(cross.nativeDrops === 2, 'native drops work inside and across out-of-process frames');
        assert(
          cross.events.every(event => event.trusted),
          'cross-site native events are trusted',
        );
        nativeStatus = { status: 'passed' };
      } else {
        const before = (await state()).events.filter(event => event.type === 'mousedown').length;
        const unsupported = await session.call('drag', {
          source: target('Native source'),
          target: target('Native destination'),
          observe: 'none',
        });
        assert(
          !unsupported.ok && unsupported.error?.code === 'NOT_INTERACTABLE',
          'native drag is explicitly unsupported',
        );
        const staged = await session.call('mouse_down', { target: target('Native source'), observe: 'none' });
        assert(!staged.ok && staged.error?.code === 'NOT_INTERACTABLE', 'staged native press is withheld');
        const after = await state();
        assert(
          after.events.filter(event => event.type === 'mousedown').length === before,
          'unsupported native paths never press',
        );
        nativeStatus = { status: 'unsupported', reason: unsupported.error!.message };
      }
      await runTool(session, 'snapshot', {});
      const down = await runTool(session, 'mouse_down', {
        target: target('Flow workspace'),
        offset: { x: 0.2, y: 0.3 },
      });
      const gestureId = (down.data as { gestureId: string }).gestureId;
      assert(down.text.includes(`gestureId: ${gestureId}`), 'the agent receives the gesture token in the tool result text');
      const blocked = await other.call('click', { target: target('Flow workspace'), observe: 'none' });
      assert(
        !blocked.ok && blocked.error?.code === 'NOT_INTERACTABLE',
        'another session cannot splice input into a gesture',
      );
      await runTool(session, 'mouse_move', { gestureId, target: target('Flow workspace'), offset: { x: 0.6, y: 0.6 } });
      await runTool(session, 'mouse_up', { gestureId, target: target('Flow workspace'), offset: { x: 0.6, y: 0.6 } });
      await runTool(session, 'mouse_down', { target: target('Flow workspace') });
      await session.cancelGestures();
      const sensitiveDown = await runTool(session, 'mouse_down', { target: target('Flow workspace') });
      const sensitiveMove = await session.call('mouse_move', {
        gestureId: (sensitiveDown.data as { gestureId: string }).gestureId,
        target: target('Delete item'),
        observe: 'none',
      });
      assert(
        !sensitiveMove.ok && sensitiveMove.error?.code === 'NEEDS_USER',
        'a new sensitive destination cancels before release',
      );
      const final = await state();
      assert(final.nativeDrops === (nativeSupported ? 2 : 0), 'Stop must not cause an extra native drop');
      assert(final.sensitiveActivations === 0, 'cancelled releases never activate the sensitive destination');
      assert(
        final.events.every(event => event.trusted),
        'all observed input is trusted',
      );
      const pressed = final.events.findIndex(event => event.type === 'mousedown' && event.buttons === 1);
      assert(pressed >= 0, 'mouse down reports buttons=1');
      assert(
        final.events.slice(pressed).some(event => event.type === 'mousemove' && event.buttons === 1),
        'movement retains buttons=1',
      );
      assert(
        final.events.some(event => event.type === 'mouseup' && event.buttons === 0),
        'release reports buttons=0',
      );
      return {
        status: nativeSupported ? 'passed' : 'partial',
        nativeHTML5: nativeStatus,
        browser: navigator.userAgent,
        slider: volume,
        canvas: { x: canvas.nodeX, y: canvas.nodeY },
        order,
        nativeDrops: final.nativeDrops,
        events: final.events,
        receipts: [slider.receipt],
      };
    } finally {
      clearInterval(watchdog);
      trace('cleaning up');
      // Closing the fixture tab is the final reset if native dragging or a blocked renderer prevents guarded cleanup.
      let cleanupTimer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          Promise.all([controller.closeSession(session), controller.closeSession(other)]),
          new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(() => reject(new Error('Gesture fixture cleanup exceeded 8000 ms')), 8000);
          }),
        ]);
      } finally {
        clearTimeout(cleanupTimer!);
        await chrome.tabs.remove(tab.id!).catch(() => undefined);
        trace('fixture closed');
      }
    }
  },
});
