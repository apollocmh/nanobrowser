import { describe, expect, it } from 'vitest';
import {
  aroundScreenshot,
  dispatchInputEvent,
  subscribeInputEvents,
  subscribeScreenshotDecorations,
} from '../input-observer';

describe('raw input observer', () => {
  it('restores the remaining decorations after one restore fails', async () => {
    let restored = false;
    const first = subscribeScreenshotDecorations(async () => async () => {
      restored = true;
    });
    const second = subscribeScreenshotDecorations(async () => async () => {
      throw new Error('restore failed');
    });
    try {
      await expect(aroundScreenshot(1, async () => 'image')).rejects.toThrow('restore failed');
      expect(restored).toBe(true);
    } finally {
      first();
      second();
    }
  });
  it('preserves sequence numbers for terminal receipts and isolates observer failures', () => {
    const phases: string[] = [];
    const unsubscribe = subscribeInputEvents(event => {
      phases.push(event.phase);
    });
    const broken = subscribeInputEvents(() => {
      throw new Error('Decoration failed');
    });
    try {
      const pending = dispatchInputEvent({
        tabId: 1,
        method: 'Input.dispatchMouseEvent',
        params: { x: 10, y: 20 },
        phase: 'pending',
      });
      const done = dispatchInputEvent({ ...pending, phase: 'confirmed' });
      expect(done.sequence).toBe(pending.sequence);
      expect(phases).toEqual(['pending', 'confirmed']);
    } finally {
      unsubscribe();
      broken();
    }
  });

  it('restores all hidden decorations even if capture fails', async () => {
    const events: string[] = [];
    const unsubscribe = subscribeScreenshotDecorations(async () => {
      events.push('hidden');
      return async () => {
        events.push('restored');
      };
    });
    try {
      await expect(
        aroundScreenshot(1, async () => {
          events.push('capture');
          throw new Error('capture failed');
        }),
      ).rejects.toThrow('capture failed');
      expect(events).toEqual(['hidden', 'capture', 'restored']);
    } finally {
      unsubscribe();
    }
  });

  it('fails before capture when a decoration cannot be hidden and restores earlier ones', async () => {
    const events: string[] = [];
    const first = subscribeScreenshotDecorations(async () => async () => {
      events.push('restored');
    });
    const second = subscribeScreenshotDecorations(async () => {
      throw new Error('Cannot hide cursor');
    });
    try {
      await expect(
        aroundScreenshot(1, async () => {
          events.push('capture');
        }),
      ).rejects.toThrow('Cannot hide cursor');
      expect(events).toEqual(['restored']);
    } finally {
      first();
      second();
    }
  });
});
