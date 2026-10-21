import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendRaw } from '../cdp-session';
import { subscribeInputEvents, subscribeScreenshotDecorations } from '../input-observer';
import type { InputEvent } from '../input-observer';

const subscriptions: Array<() => void> = [];
afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(sendCommand = vi.fn(() => new Promise<never>(() => undefined))) {
  vi.stubGlobal('navigator', { userAgent: 'Chrome/125.0.0.0' });
  vi.stubGlobal('chrome', { debugger: { sendCommand } });
  return { sendCommand };
}

describe('raw screenshot decoration cleanup', () => {
  it('restores decorations on command timeout even when Chrome never settles its promise', async () => {
    vi.useFakeTimers();
    setup();
    let hidden = false;
    subscriptions.push(
      subscribeScreenshotDecorations(async () => {
        hidden = true;
        return async () => {
          hidden = false;
        };
      }),
    );
    const command = sendRaw(7, undefined, 'Page.captureScreenshot', {}, 50);
    const rejected = expect(command).rejects.toThrow('no answer within 50 ms');
    await vi.advanceTimersByTimeAsync(1);
    expect(hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(hidden).toBe(false);
  });

  it('restores decorations when the host cancels an unresolved screenshot', async () => {
    setup();
    let cancel!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = reject;
    });
    let hidden = false;
    subscriptions.push(
      subscribeScreenshotDecorations(async () => {
        hidden = true;
        return async () => {
          hidden = false;
        };
      }),
    );
    const command = sendRaw(7, undefined, 'Page.captureScreenshot', {}, 1000, cancelled);
    const rejected = expect(command).rejects.toThrow('Stopped');
    await Promise.resolve();
    cancel(new Error('Stopped'));
    await rejected;
    expect(hidden).toBe(false);
  });

  it('does not send a late screenshot after its hide stage already exceeded the command budget', async () => {
    vi.useFakeTimers();
    const { sendCommand } = setup();
    let finishHide!: (restore: () => Promise<void>) => void;
    let restored = false;
    subscriptions.push(
      subscribeScreenshotDecorations(
        () =>
          new Promise(resolve => {
            finishHide = resolve;
          }),
      ),
    );
    const command = sendRaw(7, undefined, 'Page.captureScreenshot', {}, 20);
    const rejected = expect(command).rejects.toThrow('no answer within 20 ms');
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    finishHide(async () => {
      restored = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(restored).toBe(true);
  });
});

describe('raw input receipts', () => {
  it('uses one sequence and actual CDP coordinates for pending and terminal receipts', async () => {
    setup(vi.fn(async () => ({})) as unknown as ReturnType<typeof setup>['sendCommand']);
    const events: InputEvent[] = [];
    subscriptions.push(
      subscribeInputEvents(event => {
        events.push(event);
      }),
    );
    await sendRaw(7, undefined, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 23, y: 42, buttons: 1 });
    expect(events.map(event => event.phase)).toEqual(['pending', 'confirmed']);
    expect(events[0].sequence).toBe(events[1].sequence);
    expect(events[0].params).toEqual({ type: 'mouseMoved', x: 23, y: 42, buttons: 1 });
  });
});
