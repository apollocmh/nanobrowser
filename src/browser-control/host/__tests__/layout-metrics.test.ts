import { describe, expect, it } from 'vitest';
import { legacyMousePosition, legacyScreenshotClip, normalizeLayoutMetrics } from '../layout-metrics';
import type { LegacyMetrics } from '../layout-metrics';

const old: LegacyMetrics = {
  layoutViewport: { pageX: 150, pageY: 300, clientWidth: 1200, clientHeight: 900 },
  visualViewport: {
    pageX: 153,
    pageY: 306,
    clientWidth: 1170,
    clientHeight: 870,
    offsetX: 3,
    offsetY: 6,
    scale: 2,
    zoom: 1.5,
  },
  contentSize: { x: 15, y: 30, width: 2400, height: 6000 },
};

describe('legacy layout metrics', () => {
  it('converts old input positions with browser zoom without confusing DPR or pinch scale', () => {
    const input = { type: 'mouseMoved', x: 100, y: 150, buttons: 1 };
    expect(legacyMousePosition(input, old)).toEqual({ ...input, x: 150, y: 225 });
    expect(input.x).toBe(100);
  });

  it('converts old screenshot clip dimensions and origin while preserving its capture scale', () => {
    expect(
      legacyScreenshotClip({ format: 'png', clip: { x: 10, y: 20, width: 800, height: 2000, scale: 1 } }, old),
    ).toEqual({ format: 'png', clip: { x: 15, y: 30, width: 1200, height: 3000, scale: 1 } });
  });
  it('normalizes every old coordinate and extent using browser zoom while preserving pinch scale', () => {
    const normalized = normalizeLayoutMetrics(old);
    expect(normalized.cssLayoutViewport).toEqual({ pageX: 100, pageY: 200, clientWidth: 800, clientHeight: 600 });
    expect(normalized.cssContentSize).toEqual({ x: 10, y: 20, width: 1600, height: 4000 });
    expect(normalized.cssVisualViewport).toEqual({
      pageX: 102,
      pageY: 204,
      clientWidth: 780,
      clientHeight: 580,
      offsetX: 2,
      offsetY: 4,
      scale: 2,
      zoom: 1.5,
    });
    expect(old.layoutViewport!.pageX).toBe(150);
    expect(normalized.layoutViewport).toBe(old.layoutViewport);
  });

  it('uses an explicit CSS viewport correction when the old protocol lacks zoom', () => {
    const metrics = { ...old, visualViewport: undefined };
    expect(normalizeLayoutMetrics(metrics, 0.75).cssLayoutViewport!.clientWidth).toBe(1600);
    expect(normalizeLayoutMetrics(metrics).cssLayoutViewport).toEqual(old.layoutViewport);
  });

  it('does not double-correct modern CSS metrics', () => {
    const modern = { ...old, cssLayoutViewport: old.layoutViewport, cssContentSize: old.contentSize };
    expect(normalizeLayoutMetrics(modern, 2)).toBe(modern);
  });

  it.each([0, -1, NaN, Infinity])('rejects an unusable old layout scale %s', scale => {
    expect(() => normalizeLayoutMetrics(old, scale)).toThrow('Invalid layout metric scale');
  });

  it('rejects missing layout data rather than inventing a viewport', () => {
    expect(() => normalizeLayoutMetrics({ contentSize: old.contentSize })).toThrow('returned no layout');
  });
});
