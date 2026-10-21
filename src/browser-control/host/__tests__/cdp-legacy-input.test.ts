import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendRaw } from '../cdp-session';
import { subscribeInputEvents } from '../input-observer';
import type { InputEvent } from '../input-observer';

const legacy = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../legacy-cdp', () => ({ browserMajor: () => 80, legacyChannel: () => legacy }));

afterEach(() => {
  vi.useRealTimers();
  legacy.send.mockReset();
});

describe('legacy input coordinate boundary', () => {
  it('sends DIP coordinates once while publishing CSS coordinates to the virtual mouse', async () => {
    legacy.send.mockImplementation(async (_session: unknown, method: string) =>
      method === 'Page.getLayoutMetrics' ? { visualViewport: { zoom: 1.25 } } : {},
    );
    const events: InputEvent[] = [];
    const unsubscribe = subscribeInputEvents(event => {
      events.push(event);
    });
    try {
      await sendRaw(7, undefined, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 200, buttons: 1 });
      expect(legacy.send.mock.calls.map(call => call[1])).toEqual([
        'Page.getLayoutMetrics',
        'Input.dispatchMouseEvent',
      ]);
      expect(legacy.send.mock.calls[1][2]).toEqual({ type: 'mouseMoved', x: 125, y: 250, buttons: 1 });
      expect(events.map(event => [event.phase, event.params.x, event.params.y])).toEqual([
        ['pending', 100, 200],
        ['confirmed', 100, 200],
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('never dispatches late mouse input after the zoom measurement times out', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    legacy.send.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const command = sendRaw(7, undefined, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 20 }, 25);
    const rejected = expect(command).rejects.toThrow('no answer within 25 ms');
    await vi.advanceTimersByTimeAsync(26);
    await rejected;
    finish({ visualViewport: { zoom: 1.25 } });
    await vi.advanceTimersByTimeAsync(1);
    expect(legacy.send).toHaveBeenCalledTimes(1);
  });
});
