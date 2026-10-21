// Gesture tools use the same identity, actionability, confirmation and evidence pipeline as click. Once pressed,
// targets are checked once without scrolling: retries or scrolling with a button held can change the operation.
import type { DragArgs, MouseDownArgs, MouseMoveArgs, MouseUpArgs, Target } from '../../protocol/schemas';
import type { ActionReceipt } from '../../protocol/results';
import type { ToolContext, ToolOutcome } from '../controller';
import { checkCancelled } from '../controller';
import { LayerError } from '../../protocol/errors';
import type { Point } from '../geometry';
import { checkOnce, waitForActionable } from '../interaction/actionability';
import { assertAsShown, resolveTarget } from '../interaction/resolve';
import type { ResolvedTarget } from '../interaction/resolve';
import { afterInput, confirmGate } from '../interaction/gate';
import type { GateResult } from '../interaction/gate';
import {
  beginGesture,
  cancelGesture,
  continueGesture,
  gateInput,
  gesturePoint,
  interpolatePath,
  judgeDestination,
  moveGesturePoint,
  nativeDragPath,
} from '../interaction/gestures';
import { withEvidence } from '../interaction/evidence';
import { assertNoModal, releaseTarget, sensitivity, withTarget } from './act';
import { withPageState } from './navigate';

function assertElement(target: ResolvedTarget): void {
  if (['iframe', 'frame', 'object', 'embed'].includes(target.record.print.tag)) {
    throw new LayerError(
      'NOT_INTERACTABLE',
      'A gesture must target an observed node inside the frame, not the frame owner.',
    );
  }
}

async function approve(ctx: ToolContext, target: ResolvedTarget, intent?: string): Promise<GateResult> {
  assertElement(target);
  const gate = await confirmGate(ctx, { ...gateInput(target), intent });
  await assertAsShown(ctx, target, { context: true });
  return gate;
}

function receipt(
  action: string,
  target: ResolvedTarget,
  evidence: Pick<ActionReceipt, 'effect' | 'postcondition' | 'navigation' | 'newTab' | 'downloads'>,
  gate?: GateResult,
): ActionReceipt {
  return {
    action,
    target: `[${target.record.ref}] ${target.description}`,
    mechanism: 'pointer',
    dispatched: true,
    ...evidence,
    ...(gate ? sensitivity(gate) : {}),
  };
}

export async function mouseDown(ctx: ToolContext, args: MouseDownArgs): Promise<ToolOutcome> {
  assertNoModal(ctx);
  return withTarget(ctx, args.target, async target => {
    assertElement(target);
    await waitForActionable(ctx, target, { pointer: true, offset: args.offset, budgetMs: args.timeoutMs });
    const gate = await approve(ctx, target, args.intent);
    const actionable = await waitForActionable(ctx, target, {
      pointer: true,
      offset: args.offset,
      budgetMs: args.timeoutMs,
    });
    const { outcome, evidence } = await withEvidence(ctx, target, args.expect, {}, async () => ({
      gestureId: await beginGesture(ctx, target, actionable.point, gate, args.gestureTimeoutMs),
      dialog: undefined,
    }));
    return withPageState(ctx, args.observe, {
      receipt: receipt('mouse_down', target, evidence, gate),
      data: { gestureId: outcome.gestureId, point: actionable.point },
      lines: [`gestureId: ${outcome.gestureId} · left button held · lifetime ${args.gestureTimeoutMs ?? 30000} ms`],
    });
  });
}

async function finishStep(ctx: ToolContext, args: MouseMoveArgs | MouseUpArgs, release: boolean): Promise<ToolOutcome> {
  assertNoModal(ctx);
  try {
    return await withTarget(ctx, args.target, async target => {
      assertElement(target);
      const actionable = await checkOnce(ctx, target, {
        pointer: true,
        offset: args.offset,
        noScroll: true,
        context: false,
      });
      const { evidence } = await withEvidence(ctx, target, args.expect, {}, async () => {
        if (!release) {
          const gate = await judgeDestination(ctx, target);
          const points = interpolatePath(gesturePoint(ctx, args.gestureId), [actionable.point], 12);
          const duration = 'durationMs' in args ? (args.durationMs ?? 250) : 250;
          for (const point of points) {
            await moveGesturePoint(ctx, args.gestureId, point, [{ target, gate }]);
            if (duration) await delay(ctx, duration / points.length);
          }
        }
        await continueGesture(ctx, args.gestureId, target, actionable.point, release);
        return { dialog: undefined };
      });
      return withPageState(ctx, args.observe, {
        receipt: receipt(release ? 'mouse_up' : 'mouse_move', target, evidence),
        data: { gestureId: args.gestureId, point: actionable.point, held: !release },
        lines: [`gestureId: ${args.gestureId} · left button ${release ? 'released; gesture ended' : 'held'}`],
      });
    });
  } catch (error) {
    await cancelGesture(ctx.tab(), ctx.session.id);
    throw error;
  }
}

export const mouseMove = (ctx: ToolContext, args: MouseMoveArgs): Promise<ToolOutcome> => finishStep(ctx, args, false);
export const mouseUp = (ctx: ToolContext, args: MouseUpArgs): Promise<ToolOutcome> => finishStep(ctx, args, true);

async function delay(ctx: ToolContext, ms: number): Promise<void> {
  checkCancelled(ctx);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LayerError('CANCELLED', 'The gesture was stopped.', { delivered: true }));
    };
    const timer = setTimeout(() => {
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
  });
  checkCancelled(ctx);
}

export async function drag(ctx: ToolContext, args: DragArgs): Promise<ToolOutcome> {
  assertNoModal(ctx);
  const targets: ResolvedTarget[] = [];
  let began = false;
  try {
    const source = await resolveTarget(ctx, args.source);
    targets.push(source);
    assertElement(source);
    const destinations: Array<{ target: ResolvedTarget; offset?: Point; gate: GateResult }> = [];
    const steps: Array<{ target: Target; offset?: Point }> = [
      ...(args.path ?? []),
      { target: args.target, offset: args.offset },
    ];
    const sourceGate = await approve(ctx, source, args.intent);
    // Every possibly sensitive waypoint is approved before any button is pressed.
    for (const step of steps) {
      const target = await resolveTarget(ctx, step.target);
      targets.push(target);
      const gate = await approve(ctx, target, args.intent);
      destinations.push({ target, offset: step.offset, gate });
    }
    const start = await waitForActionable(ctx, source, {
      pointer: true,
      offset: args.sourceOffset,
      budgetMs: args.timeoutMs,
    });
    // Validate all path points without scrolling away from the source.
    const waypoints: Point[] = [];
    for (const step of destinations)
      waypoints.push((await checkOnce(ctx, step.target, { pointer: true, offset: step.offset, noScroll: true })).point);
    const end = destinations[destinations.length - 1];
    const info = await ctx.tab().probe!.call<{ native: boolean }>(source.frame, source.objectId, 'dragInfo');
    const duration = args.durationMs ?? 500;
    const points = interpolatePath(start.point, waypoints, Math.min(info.native ? 119 : 120, args.steps ?? 20));
    const { outcome, evidence } = await withEvidence(ctx, end.target, args.expect, {}, async () => {
      const gestureId = await beginGesture(ctx, source, start.point, sourceGate);
      began = true;
      if (info.native) {
        await nativeDragPath(ctx, gestureId, destinations, points, duration);
        return { gestureId, dialog: undefined };
      }
      for (const point of points) {
        await moveGesturePoint(ctx, gestureId, point, [{ target: source, gate: sourceGate }, ...destinations]);
        if (duration) await delay(ctx, duration / points.length);
      }
      const final = await checkOnce(ctx, end.target, {
        pointer: true,
        offset: end.offset,
        noScroll: true,
        context: false,
      });
      await continueGesture(ctx, gestureId, end.target, final.point, true, end.gate);
      return { gestureId, dialog: undefined };
    });
    return withPageState(ctx, args.observe, {
      receipt: receipt('drag', end.target, evidence, end.gate),
      data: { gestureId: outcome.gestureId, source: source.record.ref, target: end.target.record.ref },
    });
  } catch (error) {
    await cancelGesture(ctx.tab(), ctx.session.id);
    throw began
      ? afterInput(error, true, 'Earlier gesture input reached the page; the remaining drag was cancelled.')
      : error;
  } finally {
    await Promise.all(targets.map(target => releaseTarget(ctx, target).catch(() => undefined)));
  }
}
