import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputEvent } from '@src/browser-control';
import { PageCursor, setCursor } from '../cursor';
import type { CursorUpdate } from '../cursor';

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__nbVirtualCursorEpoch');
  vi.unstubAllGlobals();
});

function setup() {
  const sent: CursorUpdate[] = [];
  let enabled = true;
  const cursor = new PageCursor({
    enabled: async () => enabled,
    inject: async (_tabId, update) => {
      sent.push(update);
    },
  });
  const event = (sequence: number, phase: InputEvent['phase'] = 'pending'): InputEvent => ({
    tabId: 1,
    sequence,
    phase,
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mousePressed', x: sequence * 10, y: 20, buttons: 1 },
  });
  return {
    cursor,
    sent,
    event,
    disable: () => {
      enabled = false;
    },
  };
}

describe('PageCursor', () => {
  it('an already-dispatched old injection cannot recreate the removed decoration after navigation', () => {
    const createElement = vi.fn(() => { throw new Error('Old input must not create DOM'); });
    vi.stubGlobal('document', { createElement });
    setCursor({ state: 'off', epoch: 20, sequence: 0 });
    setCursor({ state: 'input', epoch: 19, sequence: 100, x: 10, y: 20, phase: 'pending' });
    expect(createElement).not.toHaveBeenCalled();
  });
  it('holds the screenshot barrier while an input waits for its setting', async () => {
    let enabled!: (value: boolean) => void;
    const sent: CursorUpdate[] = [];
    const cursor = new PageCursor({
      enabled: () =>
        new Promise<boolean>(resolve => {
          enabled = resolve;
        }),
      inject: async (_id, update) => {
        sent.push(update);
      },
    });
    const input = cursor.input({
      tabId: 1,
      sequence: 1,
      phase: 'pending',
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 10, y: 20 },
    });
    const restore = await cursor.hide(1);
    enabled(true);
    await input;
    expect(sent[sent.length - 1]).toMatchObject({ state: 'input', hidden: true });
    await restore();
    expect(sent[sent.length - 1].state).toBe('visible');
  });
  it('uses real coordinates and does not replay a completion behind a newer movement', async () => {
    const { cursor, sent, event } = setup();
    await cursor.input(event(1));
    await cursor.input(event(2));
    await cursor.input(event(1, 'confirmed'));
    await cursor.input(event(2, 'unknown'));
    expect(sent.map(update => [update.sequence, update.phase, update.x, update.buttons])).toEqual([
      [1, 'pending', 10, 1],
      [2, 'pending', 20, 1],
      [2, 'unknown', 20, 1],
    ]);
  });

  it('keeps overlapping screenshots hidden until both finish, including input during capture', async () => {
    const { cursor, sent, event } = setup();
    await cursor.input(event(1));
    const restoreA = await cursor.hide(1);
    const restoreB = await cursor.hide(1);
    await cursor.input(event(2));
    expect(sent[sent.length - 1]).toMatchObject({ state: 'input', hidden: true, x: 20 });
    await restoreA();
    expect(sent.some(update => update.state === 'visible')).toBe(false);
    await restoreB();
    expect(sent[sent.length - 1].state).toBe('visible');
    await restoreB();
    expect(sent.filter(update => update.state === 'visible')).toHaveLength(1);
  });

  it('a restore cannot recreate an overlay cleared by Stop or navigation', async () => {
    const { cursor, sent, event } = setup();
    await cursor.input(event(1));
    const restore = await cursor.hide(1);
    const firstEpoch = sent[0].epoch;
    await cursor.clear(1, 'next-document');
    await cursor.input(event(1, 'confirmed'));
    await restore();
    expect(sent[sent.length - 1].state).toBe('off');
    await cursor.input(event(2));
    expect(sent[sent.length - 1].epoch).toBeGreaterThan(firstEpoch);
  });

  it('honors the setting immediately and does not inject into an untouched tab during a screenshot', async () => {
    const { cursor, sent, event, disable } = setup();
    await (
      await cursor.hide(2)
    )();
    expect(sent).toEqual([]);
    await cursor.input(event(1));
    disable();
    await cursor.settingChanged();
    await cursor.input(event(2));
    expect(sent[sent.length - 1].state).toBe('off');
  });

  it('does not turn keyboard input into cursor movement', async () => {
    const { cursor, sent, event } = setup();
    await cursor.input({ ...event(1), method: 'Input.dispatchKeyEvent' });
    await cursor.input({ ...event(2), params: { type: 'mousePressed', x: NaN, y: 2 } });
    expect(sent).toEqual([]);
  });

  it('ignores movement and scrolling, so only the last click places the pointer', async () => {
    const { cursor, sent, event } = setup();
    await cursor.input({ ...event(1), params: { type: 'mouseMoved', x: 10, y: 20, buttons: 0 } });
    await cursor.input({ ...event(2), params: { type: 'mouseWheel', x: 10, y: 20 } });
    expect(sent).toEqual([]);
    await cursor.input(event(3));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ x: 30, y: 20, type: 'mousePressed' });
  });
});
