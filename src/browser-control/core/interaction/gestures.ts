// A held button belongs to one conversation and one source document. Every event is sent once, with explicit
// buttons state. Cancellation clears native drag state before a withheld release can reach page handlers.
import { LayerError } from '../../protocol/errors';
import type { TabState, ToolContext } from '../controller';
import { checkCancelled } from '../controller';
import type { Point } from '../geometry';
import { nodeAtViewportPoint } from '../geometry';
import { assertAsShown, axIdentity } from './resolve';
import type { GateResult } from './gate';
import { afterInput, assertJudged, classifyOn } from './gate';
import type { ResolvedTarget } from './resolve';
import { preflightNavigation } from './preflight';
import { sendWithheld } from './withheld';
import type { GuardReport } from '../../probe';
import { siteOf } from '../site';
import { NodeArg } from '../probe-client';

interface HeldGesture {
  id: string;
  owner: string;
  source: ResolvedTarget;
  gate: GateResult;
  point: Point;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  removeAbort: () => void;
  cancelled: boolean;
  pending?: Promise<unknown>;
  native?: boolean;
}

const held = new WeakMap<TabState, HeldGesture>();
const cleaning = new WeakMap<TabState, Promise<boolean>>();
let nextGesture = 0;

/** Chromium only gained a CDP-controlled native HTML drag loop in 2023. Earlier Windows builds enter an OS
 * modal loop which neither CDP mouse release nor Escape can reliably end. Refuse before pressing, rather than
 * strand the tab or pretend a synthetic DOM drop is equivalent. Custom mouse/pointer dragging is unaffected. */
export async function assertNativeDragSupport(ctx: ToolContext, source: ResolvedTarget): Promise<boolean> {
  const native = await ctx.tab().probe!.call<{ native: boolean }>(source.frame, source.objectId, 'dragInfo');
  if (!native.native) return false;
  const attachment = await ctx.attach();
  if (!attachment.cdp.capabilities?.nativeDrag)
    throw new LayerError(
      'NOT_INTERACTABLE',
      'This Chromium version has no CDP-controlled native HTML5 drag-and-drop. Native input was withheld. Use Chrome 117+ or let the user perform this native drag. Mouse/pointer sliders, sorters and canvas dragging remain available.',
    );
  return true;
}

export function gestureOwner(tab: TabState): string | undefined {
  return held.get(tab)?.owner;
}

/** Called inside the tab lock. An unrelated input cannot splice itself into a held gesture. */
export function assertGestureTool(tab: TabState, owner: string, tool: string, readOnly: boolean): void {
  const gesture = held.get(tab);
  if (!gesture) return;
  if (gesture.owner !== owner || (!readOnly && tool !== 'mouse_move' && tool !== 'mouse_up')) {
    throw new LayerError(
      'NOT_INTERACTABLE',
      'A mouse gesture owns this tab. Finish it or stop its conversation first.',
    );
  }
}

/** Returns whether the native button was released. False is retained as a blocked state, never silently reused. */
export function cancelGesture(tab: TabState, owner?: string): Promise<boolean> {
  const gesture = held.get(tab);
  if (!gesture || (owner !== undefined && gesture.owner !== owner)) return Promise.resolve(true);
  const running = cleaning.get(tab);
  if (running) return running;
  gesture.cancelled = true;
  clearTimeout(gesture.timer);
  gesture.removeAbort();
  const cleanup = (async () => {
    await gesture.pending?.catch(() => undefined);
    if (!tab.attachment || tab.attachment.detached) {
      held.delete(tab);
      return true;
    }
    if (tab.dialog) {
      // A blocking renderer cannot arm a guard. The dialog handler runs this cleanup immediately after closing it.
      tab.pendingRelease = async () => {
        await cancelGesture(tab);
        return 'The mouse gesture was cancelled; its release was withheld from the page.';
      };
      return false;
    }
    const released = await sendWithheld(tab, 'all', async () => {
      const cdp = tab.attachment!.cdp;
      if (gesture.native) await cdp.send(undefined, 'Input.cancelDragging', {}, 2000);
      // Escape cancels Chromium's native HTML drag loop. This input is also withheld from page key handlers.
      await cdp.send(
        undefined,
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        2000,
      );
      await cdp.send(
        undefined,
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        2000,
      );
      await cdp.send(
        undefined,
        'Input.dispatchMouseEvent',
        {
          type: 'mouseReleased',
          button: 'left',
          buttons: 0,
          clickCount: 1,
          ...gesture.point,
        },
        2000,
      );
    }).catch(() => false);
    if (released) {
      await tab.probe?.callGlobal(gesture.source.frame, 'disarmNativeDragGuard').catch(() => undefined);
      held.delete(tab);
    }
    return released;
  })().finally(() => cleaning.delete(tab));
  cleaning.set(tab, cleanup);
  return cleanup;
}

/** A fixed, bounded geometric path. Every point becomes one real CDP mouse movement, not an overlay animation. */
export function interpolatePath(start: Point, waypoints: Point[], requestedSteps = 20): Point[] {
  const count = Math.min(120, Math.max(waypoints.length, requestedSteps));
  const points: Point[] = [];
  let previous = start;
  waypoints.forEach((destination, index) => {
    const steps = Math.floor(((index + 1) * count) / waypoints.length) - Math.floor((index * count) / waypoints.length);
    for (let step = 1; step <= steps; step++) {
      const ratio = step / steps;
      points.push({
        x: previous.x + (destination.x - previous.x) * ratio,
        y: previous.y + (destination.y - previous.y) * ratio,
      });
    }
    previous = destination;
  });
  return points;
}

/** Modern Chromium routes native drag data through CDP. Guard each frame and recheck the source before release. */
export async function nativeDragPath(
  ctx: ToolContext,
  id: string,
  destinations: Array<{ target: ResolvedTarget; gate: GateResult }>,
  points: Point[],
  durationMs: number,
): Promise<void> {
  const gesture = current(ctx, id);
  const tab = ctx.tab();
  const probe = tab.probe!;
  const frames = await tab.attachment!.topology.frames();
  const targets = [gesture.source, ...destinations.map(step => step.target)];
  for (const frame of frames) {
    const local = targets.filter(target => target.frame.frameId === frame.frameId);
    if (local.length)
      await probe.call(
        frame,
        local[0].objectId,
        'armNativeDragGuard',
        Math.max(1, gesture.deadline - Date.now()),
        ...local.slice(1).map(target => new NodeArg(target.objectId)),
      );
    else await probe.callGlobal(frame, 'armBlockGuard', 'all', Math.max(1, gesture.deadline - Date.now()));
  }
  gesture.native = true;
  const send = async (type: 'mouseMoved' | 'mouseReleased', point: Point) => {
    current(ctx, id);
    checkCancelled(ctx);
    gesture.point = point;
    tab.actionSeq++;
    gesture.pending = tab.attachment!.cdp.send(
      undefined,
      'Input.dispatchMouseEvent',
      {
        type,
        ...point,
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: type === 'mouseReleased' ? 1 : 0,
      },
      5000,
    );
    await gesture.pending;
  };
  try {
    for (const point of points) {
      await send('mouseMoved', point);
      if (durationMs) await new Promise(resolve => setTimeout(resolve, durationMs / Math.max(1, points.length)));
    }
    // Chromium needs a dragover at the final point before mouseReleased commits the native drop.
    await checkSource(ctx, gesture);
    for (const step of destinations) {
      await sameDocument(ctx, step.target);
      await assertAsShown(ctx, step.target, { context: false });
      await assertJudged(ctx, gateInput(step.target), step.gate, 'the native drop');
      await preflightNavigation(ctx, step.target.frame, step.target.objectId, 'activate', step.target.description);
    }
    await send('mouseMoved', points[points.length - 1]);
    await send('mouseReleased', points[points.length - 1]);
    const reports = await Promise.all(frames.map(frame => probe.callGlobal<GuardReport>(frame, 'readGuard')));
    if (reports.some(report => report.verdict === 'cancelled' && report.hit !== 'withheld'))
      throw new LayerError(
        'INTERCEPTED',
        'The native drag source or approved drop target changed; the drop was withheld.',
        { delivered: true },
      );
    forgetGesture(tab);
  } catch (error) {
    await cancelGesture(tab);
    throw afterInput(error, true, 'Native drag input was sent once; the unfinished gesture was cancelled.');
  } finally {
    await Promise.all(
      frames.map(async frame => {
        await probe.callGlobal(frame, 'disarmNativeDragGuard').catch(() => undefined);
        await probe.callGlobal(frame, 'disarm').catch(() => undefined);
      }),
    );
  }
}

/** Read the actual node at an interpolated point. Background motion is allowed; newly sensitive nodes cancel. */
export async function moveGesturePoint(
  ctx: ToolContext,
  id: string,
  point: Point,
  approved: Array<{ target: ResolvedTarget; gate: GateResult }>,
): Promise<void> {
  const gesture = current(ctx, id);
  try {
    await checkSource(ctx, gesture);
    const { cdp, topology } = await ctx.attach();
    const frames = await topology.frames();
    const hit = await nodeAtViewportPoint(cdp, undefined, point);
    const frame = hit && frames.find(candidate => candidate.frameId === hit.frameId);
    if (!hit || !frame)
      throw new LayerError('NOT_VISIBLE', 'The mouse path left the captured page.', { delivered: true });
    const probe = ctx.tab().probe!;
    const objectId = await probe.resolve(frame, hit.backendNodeId);
    try {
      const identity = await axIdentity(ctx, frame, hit.backendNodeId);
      const target: ResolvedTarget = {
        frame,
        frames,
        objectId,
        via: 'ref',
        description: 'the node under the interpolated mouse path',
        record: {
          ...gesture.source.record,
          ref: '(path)',
          backendNodeId: hit.backendNodeId,
          frameId: frame.frameId,
          sessionId: frame.sessionId,
          loaderId: frame.loaderId,
          print: {
            ...gesture.source.record.print,
            role: 'hidden' in identity ? '' : identity.role,
            name: 'hidden' in identity ? '' : identity.name,
            context: null,
          },
        },
      };
      const judgement = await classifyOn(ctx, gateInput(target));
      const known =
        approved.find(
          entry =>
            entry.target.frame.frameId === frame.frameId && entry.target.record.backendNodeId === hit.backendNodeId,
        ) ??
        (gesture.source.frame.frameId === frame.frameId && gesture.source.record.backendNodeId === hit.backendNodeId
          ? { target: gesture.source, gate: gesture.gate }
          : undefined);
      if (judgement.category) {
        if (!known)
          throw new LayerError(
            'NEEDS_USER',
            'The interpolated drag reached a new sensitive target; the gesture was cancelled.',
            { delivered: true },
          );
        await assertJudged(ctx, gateInput(target), known.gate, 'the interpolated movement');
      }
      await guardedEvent(ctx, target, point, 'mouseMoved', gesture);
    } finally {
      await probe.release(frame, objectId);
    }
  } catch (error) {
    await cancelGesture(ctx.tab());
    throw afterInput(error, true, 'Earlier gesture input reached the page; the remaining pointer path was cancelled.');
  }
}

/** A detached debugger has already discarded Chromium's input state. */
export function forgetGesture(tab: TabState): void {
  const gesture = held.get(tab);
  if (gesture) {
    clearTimeout(gesture.timer);
    gesture.removeAbort();
    gesture.cancelled = true;
    held.delete(tab);
  }
}

function current(ctx: ToolContext, id: string): HeldGesture {
  const gesture = held.get(ctx.tab());
  if (!gesture || gesture.id !== id || gesture.owner !== ctx.session.id) {
    throw new LayerError('INVALID_ARGUMENT', 'This gesture does not belong to this session and tab, or it has ended.');
  }
  if (gesture.cancelled || Date.now() >= gesture.deadline) {
    throw new LayerError('CANCELLED', 'The mouse gesture has expired or was cancelled.', { delivered: true });
  }
  return gesture;
}

export function gesturePoint(ctx: ToolContext, id: string): Point {
  return { ...current(ctx, id).point };
}

async function sameDocument(ctx: ToolContext, target: ResolvedTarget): Promise<void> {
  const frames = await (await ctx.attach()).topology.frames();
  const frame = frames.find(f => f.frameId === target.frame.frameId);
  if (!frame || frame.loaderId !== target.record.loaderId) {
    throw new LayerError('STALE_DOCUMENT', 'The document of the mouse gesture changed.', { delivered: true });
  }
}

/** The source can move, but it cannot be replaced, renamed, or turned into a different sensitive action. */
async function checkSource(ctx: ToolContext, gesture: HeldGesture): Promise<void> {
  await sameDocument(ctx, gesture.source);
  const probe = ctx.tab().probe!;
  const objectId = await probe.resolve(gesture.source.frame, gesture.source.record.backendNodeId);
  const source = { ...gesture.source, objectId };
  try {
    await assertAsShown(ctx, source, { context: false });
    await assertJudged(ctx, gateInput(source), gesture.gate, 'the next mouse event');
    // A page may switch draggable on in its mousedown handler. Catch that before the first held movement too.
    if (await assertNativeDragSupport(ctx, source)) gesture.native = true;
  } finally {
    await probe.release(source.frame, objectId);
  }
}

export function gateInput(target: ResolvedTarget) {
  return {
    mode: 'activate' as const,
    frame: target.frame,
    objectId: target.objectId,
    name: target.record.print.name,
    shown: target.record.print.shown,
    role: target.record.print.role,
    description: target.description,
    action: 'mouse gesture',
  };
}

/** A new approval is never awaited while a button is down. Auto/site allowance can still admit a detected write. */
export async function judgeDestination(
  ctx: ToolContext,
  target: ResolvedTarget,
  approved?: GateResult,
): Promise<GateResult> {
  const input = gateInput(target);
  const judgement = await classifyOn(ctx, input);
  if (ctx.session.handover && (judgement.category === 'pay' || judgement.category === 'grant')) {
    throw new LayerError('USER_STEP', `This ${judgement.category} destination is the user's step.`, {
      delivered: true,
    });
  }
  if (approved) {
    await assertJudged(ctx, input, approved, 'the next mouse event');
    return approved;
  }
  if (judgement.category && ctx.session.confirmPolicy !== 'never') {
    const decision =
      ctx.session.decideWrite && (judgement.category === 'submit' || judgement.category === 'delete')
        ? await ctx.session.decideWrite({
            category: judgement.category,
            site: siteOf(target.frame.url),
            tabId: ctx.tab().tabId,
          })
        : undefined;
    if (decision?.decision !== 'run') {
      throw new LayerError(
        'NEEDS_USER',
        'The gesture reached a new sensitive destination. It was cancelled before release; approve a new drag before pressing.',
        { delivered: true },
      );
    }
    return {
      ...judgement,
      category: judgement.category,
      confirmedByUser: false,
      prompted: false,
      allowedBy: decision.by ?? 'auto',
    };
  }
  return { ...judgement, category: judgement.category ?? undefined, confirmedByUser: false, prompted: false };
}

async function guardedEvent(
  ctx: ToolContext,
  target: ResolvedTarget,
  point: Point,
  type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
  gesture: HeldGesture,
): Promise<void> {
  checkCancelled(ctx);
  current(ctx, gesture.id);
  await sameDocument(ctx, target);
  const tab = ctx.tab();
  const probe = tab.probe!;
  const frames = await tab.attachment!.topology.frames();
  await probe.call(
    target.frame,
    target.objectId,
    type === 'mousePressed' ? 'armGuard' : 'armDragGuard',
    ...(type === 'mousePressed' ? ['pointer'] : []),
  );
  // A misrouted press must not activate something in another process/frame.
  if (type === 'mousePressed') {
    await Promise.all(
      frames.filter(f => f.frameId !== target.frame.frameId).map(f => probe.callGlobal(f, 'armAncestorGuard')),
    );
  }
  try {
    current(ctx, gesture.id);
    gesture.point = point;
    tab.actionSeq++;
    gesture.pending = tab.attachment!.cdp.send(
      undefined,
      'Input.dispatchMouseEvent',
      {
        type,
        ...point,
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: type === 'mouseMoved' ? 0 : 1,
      },
      5000,
    );
    await gesture.pending;
    const reports = await Promise.all(
      (type === 'mousePressed' ? frames : [target.frame]).map(f => probe.callGlobal<GuardReport>(f, 'readGuard')),
    );
    if (reports.some(r => r.verdict === 'cancelled')) {
      throw new LayerError('INTERCEPTED', 'The mouse gesture was intercepted by a different target at dispatch time.', {
        delivered: true,
      });
    }
    if (tab.dialog)
      throw new LayerError('MODAL_PENDING', 'A dialog interrupted the mouse gesture.', { delivered: true });
  } finally {
    gesture.pending = undefined;
    if (!tab.dialog) await Promise.all(frames.map(f => probe.callGlobal(f, 'disarm').catch(() => undefined)));
  }
}

export async function beginGesture(
  ctx: ToolContext,
  source: ResolvedTarget,
  point: Point,
  gate: GateResult,
  timeoutMs = 30000,
): Promise<string> {
  if (held.has(ctx.tab())) throw new LayerError('NOT_INTERACTABLE', 'This tab already has a held mouse gesture.');
  checkCancelled(ctx);
  const native = await assertNativeDragSupport(ctx, source);
  const id = `${ctx.controller.epoch.prefix}-${ctx.session.id}-g${++nextGesture}`;
  const onAbort = () => void cancelGesture(ctx.tab(), ctx.session.id);
  const gesture: HeldGesture = {
    id,
    owner: ctx.session.id,
    source,
    gate,
    point,
    deadline: Date.now() + timeoutMs,
    timer: setTimeout(() => void cancelGesture(ctx.tab()), timeoutMs),
    removeAbort: () => ctx.signal?.removeEventListener('abort', onAbort),
    cancelled: false,
    native,
  };
  held.set(ctx.tab(), gesture);
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  let moved = false;
  try {
    if (!ctx.tab().attachment!.cdp.capabilities?.nativeDrag)
      await ctx.tab().probe!.callGlobal(source.frame, 'armNativeDragBlock', timeoutMs);
    await assertAsShown(ctx, source, { context: true });
    await assertJudged(ctx, gateInput(source), gate, 'the press');
    await preflightNavigation(ctx, source.frame, source.objectId, 'activate', source.description);
    await assertNativeDragSupport(ctx, source);
    await ctx
      .tab()
      .attachment!.cdp.send(undefined, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 });
    moved = true;
    await assertAsShown(ctx, source, { context: true });
    await assertJudged(ctx, gateInput(source), gate, 'the press');
    await preflightNavigation(ctx, source.frame, source.objectId, 'activate', source.description);
    await guardedEvent(ctx, source, point, 'mousePressed', gesture);
    return id;
  } catch (error) {
    await cancelGesture(ctx.tab());
    throw moved
      ? afterInput(error, true, 'The pointer was moved; the gesture was cancelled and its release withheld.')
      : error;
  }
}

export async function continueGesture(
  ctx: ToolContext,
  id: string,
  target: ResolvedTarget,
  point: Point,
  release: boolean,
  approved?: GateResult,
): Promise<void> {
  const gesture = current(ctx, id);
  const onAbort = () => void cancelGesture(ctx.tab(), ctx.session.id);
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await checkSource(ctx, gesture);
    await assertAsShown(ctx, target, { context: false });
    const gate = await judgeDestination(
      ctx,
      target,
      approved ??
        (target.record.backendNodeId === gesture.source.record.backendNodeId &&
        target.frame.frameId === gesture.source.frame.frameId
          ? gesture.gate
          : undefined),
    );
    await assertJudged(ctx, gateInput(target), gate, 'the next mouse event');
    await preflightNavigation(ctx, target.frame, target.objectId, 'activate', target.description);
    await guardedEvent(ctx, target, point, release ? 'mouseReleased' : 'mouseMoved', gesture);
    if (release) {
      await ctx.tab().probe!.callGlobal(gesture.source.frame, 'disarmNativeDragGuard');
      forgetGesture(ctx.tab());
    }
  } catch (error) {
    await cancelGesture(ctx.tab());
    throw afterInput(
      error,
      true,
      'Earlier gesture input reached the page. The rest was cancelled and the release withheld.',
    );
  } finally {
    ctx.signal?.removeEventListener('abort', onAbort);
  }
}
