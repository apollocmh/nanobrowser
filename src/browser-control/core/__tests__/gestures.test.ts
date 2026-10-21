import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertGestureTool,
  beginGesture,
  cancelGesture,
  continueGesture,
  forgetGesture,
  gestureOwner,
  assertNativeDragSupport,
  interpolatePath,
} from '../interaction/gestures';
import { quadPoint } from '../interaction/actionability';
import type { ToolContext, TabState } from '../controller';
import type { CdpPort, FrameRecord } from '../ports';
import type { ResolvedTarget } from '../interaction/resolve';
import type { GateResult } from '../interaction/gate';
import { DragArgsSchema, MouseDownArgsSchema, MouseMoveArgsSchema } from '../../protocol/schemas';

const frame: FrameRecord = {
  frameId: 'main',
  parentFrameId: undefined,
  loaderId: 'document-1',
  sessionId: undefined,
  url: 'https://fixture.test/',
  depth: 0,
  adFrame: false,
};
const gate: GateResult = { category: undefined, reason: 'not sensitive', prompted: false, confirmedByUser: false };

function setup() {
  let loaderId = frame.loaderId;
  let liveName = 'Node A';
  let failGuards = false;
  let native = false;
  const input: Array<Record<string, unknown>> = [];
  const send = vi.fn(async (_session: unknown, method: string, params: Record<string, unknown> = {}) => {
    if (method.startsWith('Input.')) input.push({ method, ...params });
    if (method === 'Accessibility.getPartialAXTree')
      return {
        nodes: [{ backendDOMNodeId: params.backendNodeId, role: { value: 'button' }, name: { value: liveName } }],
      };
    return {};
  });
  const call = vi.fn(async (_frame: unknown, _object: unknown, method: string) => {
    if (method === 'dragInfo') return { native };
    if (method === 'formFacts')
      return {
        tag: 'div',
        type: '',
        classes: '',
        isLink: false,
        submitter: false,
        field: false,
        form: null,
        money: '',
        textEntry: false,
        searchField: false,
      };
    if (method === 'navigationTarget') return null;
    return { connected: true };
  });
  const tab = {
    tabId: 7,
    actionSeq: 0,
    dialog: null,
    pendingRelease: null,
    attachment: {
      cdp: { send: send as unknown as CdpPort['send'], capabilities: { nativeDrag: true } },
      topology: { frames: async () => [{ ...frame, loaderId }] },
      detached: null,
    },
    probe: {
      call,
      resolve: async () => 'resolved-node',
      release: async () => undefined,
      callGlobal: vi.fn(async (_frame: unknown, method: string) => {
        if (failGuards && method === 'armBlockGuard') throw new Error('world is gone');
        return { verdict: 'passed', seen: ['pointerdown', 'mousedown'], accepted: 2 };
      }),
    },
  } as unknown as TabState;
  const abort = new AbortController();
  const ctx = {
    tab: () => tab,
    attach: async () => tab.attachment!,
    signal: abort.signal,
    controller: { epoch: { prefix: 'a' }, allowedFor: () => () => true },
    session: { id: 'session-1', confirmPolicy: 'sensitive', handover: true },
  } as unknown as ToolContext;
  const target: ResolvedTarget = {
    objectId: 'node-a',
    frame,
    frames: [frame],
    description: 'Node A',
    via: 'ref',
    record: {
      ref: 'a1',
      tabId: 7,
      sessionId: undefined,
      frameId: 'main',
      loaderId: frame.loaderId,
      backendNodeId: 12,
      source: 'ax',
      stale: null,
      print: { role: 'button', name: 'Node A', tag: 'div', text: '', nth: null, context: null },
    },
  };
  return {
    ctx,
    target,
    tab,
    input,
    send,
    abort,
    native: (version = 'Chrome/125.0.0.0') => {
      native = true;
      Object.assign(tab.attachment!.cdp, {
        capabilities: { nativeDrag: Number(/\/(\d+)/.exec(version)?.[1] ?? 0) >= 125 },
      });
    },
    changeDocument: () => {
      loaderId = 'document-2';
    },
    changeName: () => {
      liveName = 'Delete';
    },
    failGuards: () => {
      failGuards = true;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('trusted mouse gesture state', () => {
  it('rejects native HTML drag before any input on Chromium 80, including staged presses', async () => {
    const { ctx, target, input, native } = setup();
    native('Chrome/80.0.3987.149');
    await expect(assertNativeDragSupport(ctx, target)).rejects.toMatchObject({ code: 'NOT_INTERACTABLE' });
    await expect(beginGesture(ctx, target, { x: 20, y: 30 }, gate)).rejects.toMatchObject({ code: 'NOT_INTERACTABLE' });
    expect(input).toEqual([]);
  });

  it('cancels a qualified native drag before releasing and never retries the native input', async () => {
    const { ctx, target, tab, input, native } = setup();
    native();
    await beginGesture(ctx, target, { x: 20, y: 30 }, gate);
    await cancelGesture(tab);
    expect(input.filter(event => event.method === 'Input.cancelDragging')).toHaveLength(1);
    expect(input.findIndex(event => event.method === 'Input.cancelDragging')).toBeLessThan(
      input.findIndex(event => event.type === 'mouseReleased'),
    );
  });

  it('rejects a source switched to native dragging after press before moving it', async () => {
    const { ctx, target, tab, input, native } = setup();
    const id = await beginGesture(ctx, target, { x: 20, y: 30 }, gate);
    native('Chrome/80.0.3987.149');
    await expect(continueGesture(ctx, id, target, { x: 70, y: 80 }, false)).rejects.toMatchObject({
      code: 'NOT_INTERACTABLE',
    });
    expect(input.filter(event => event.type === 'mouseMoved')).toHaveLength(1);
    expect(gestureOwner(tab)).toBeUndefined();
  });
  it('sends press, held move and release once with explicit buttons, then forgets the gesture', async () => {
    const { ctx, target, tab, input } = setup();
    const id = await beginGesture(ctx, target, { x: 20, y: 30 }, gate);
    await continueGesture(ctx, id, target, { x: 70, y: 80 }, false);
    await continueGesture(ctx, id, target, { x: 70, y: 80 }, true);
    expect(input.map(p => [p.type, p.buttons])).toEqual([
      ['mouseMoved', 0],
      ['mousePressed', 1],
      ['mouseMoved', 1],
      ['mouseReleased', 0],
    ]);
    expect(gestureOwner(tab)).toBeUndefined();
  });

  it('refuses interleaved inputs and foreign session tokens', async () => {
    const { ctx, target, tab } = setup();
    const id = await beginGesture(ctx, target, { x: 20, y: 30 }, gate);
    expect(() => assertGestureTool(tab, 'session-2', 'snapshot', true)).toThrow(/owns this tab/);
    expect(() => assertGestureTool(tab, 'session-1', 'click', false)).toThrow(/owns this tab/);
    expect(() => assertGestureTool(tab, 'session-1', 'snapshot', true)).not.toThrow();
    await expect(
      continueGesture(
        { ...ctx, session: { ...ctx.session, id: 'session-2' } } as ToolContext,
        id,
        target,
        { x: 30, y: 40 },
        true,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await cancelGesture(tab);
  });

  it('cancels navigation before another move and withholds Escape plus release', async () => {
    const { ctx, target, tab, input, changeDocument } = setup();
    const id = await beginGesture(ctx, target, { x: 20, y: 30 }, gate);
    changeDocument();
    await expect(continueGesture(ctx, id, target, { x: 70, y: 80 }, false)).rejects.toMatchObject({
      code: 'STALE_DOCUMENT',
    });
    expect(input.filter(p => p.type === 'mouseMoved')).toHaveLength(1);
    expect(input.slice(-3).map(p => p.type)).toEqual(['keyDown', 'keyUp', 'mouseReleased']);
    expect(gestureOwner(tab)).toBeUndefined();
  });

  it('does not release into a changed source or blindly retry an input timeout', async () => {
    const { ctx, target, tab, input, changeName } = setup();
    const id = await beginGesture(ctx, target, { x: 20, y: 30 }, gate);
    changeName();
    await expect(continueGesture(ctx, id, target, { x: 40, y: 40 }, true)).rejects.toMatchObject({
      code: 'TARGET_CHANGED',
    });
    expect(input.filter(p => p.type === 'mousePressed')).toHaveLength(1);
    expect(input.filter(p => p.type === 'mouseReleased')).toHaveLength(1);
    expect(gestureOwner(tab)).toBeUndefined();
  });

  it('keeps a cancelled gesture blocked if safe release guards cannot be installed', async () => {
    const { ctx, target, tab, input, failGuards } = setup();
    await beginGesture(ctx, target, { x: 20, y: 30 }, gate);
    failGuards();
    expect(await cancelGesture(tab)).toBe(false);
    expect(input.filter(p => p.type === 'mouseReleased')).toHaveLength(0);
    expect(() => assertGestureTool(tab, 'session-1', 'click', false)).toThrow();
    forgetGesture(tab);
  });

  it('times out a staged gesture without requiring another agent call', async () => {
    vi.useFakeTimers();
    const { ctx, target, tab, input } = setup();
    await beginGesture(ctx, target, { x: 20, y: 30 }, gate, 1000);
    await vi.advanceTimersByTimeAsync(1001);
    expect(gestureOwner(tab)).toBeUndefined();
    expect(input.filter(p => p.type === 'mouseReleased')).toHaveLength(1);
  });
});

describe('bounded gesture protocol', () => {
  it('interpolates a bounded path and reaches every waypoint exactly', () => {
    const points = interpolatePath(
      { x: 0, y: 0 },
      [
        { x: 10, y: 20 },
        { x: 40, y: 30 },
      ],
      20,
    );
    expect(points).toHaveLength(20);
    expect(points[9]).toEqual({ x: 10, y: 20 });
    expect(points[19]).toEqual({ x: 40, y: 30 });
    expect(interpolatePath({ x: 0, y: 0 }, [{ x: 10, y: 20 }], 999)).toHaveLength(120);
  });
  it('rejects unbounded lifetimes, paths and offsets outside the observed element', () => {
    expect(MouseDownArgsSchema.safeParse({ target: { ref: 'a1' }, gestureTimeoutMs: 120001 }).success).toBe(false);
    expect(
      MouseMoveArgsSchema.safeParse({ target: { ref: 'a1' }, gestureId: 'g', offset: { x: -0.1, y: 0.5 } }).success,
    ).toBe(false);
    expect(
      DragArgsSchema.safeParse({
        source: { ref: 'a1' },
        target: { ref: 'a2' },
        path: Array.from({ length: 61 }, () => ({ target: { ref: 'a2' } })),
      }).success,
    ).toBe(false);
  });

  it('uses target-local fractions for transformed quads', () => {
    expect(quadPoint([10, 10, 30, 30, 10, 50, -10, 30], { x: 0.75, y: 0.25 })).toEqual({ x: 20, y: 30 });
  });
});
