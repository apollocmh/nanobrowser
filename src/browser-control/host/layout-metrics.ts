// Older CDP exposes the layout metrics under unprefixed names. Consumers use one shape.
// A browser zoom correction can be supplied from the isolated probe's CSS viewport measurement.
export interface LegacyMetrics {
  layoutViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  visualViewport?: {
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
    scale: number;
    offsetX: number;
    offsetY: number;
    zoom?: number;
  };
  contentSize?: { x: number; y: number; width: number; height: number };
  cssLayoutViewport?: LegacyMetrics['layoutViewport'];
  cssVisualViewport?: LegacyMetrics['visualViewport'];
  cssContentSize?: LegacyMetrics['contentSize'];
}

/** Before Chromium 102 InputHandler applies pinch scale but omits browser zoom. Quads and hit tests already use
 * CSS pixels; only the legacy mouse dispatch position needs conversion to device-independent viewport pixels. */
export function legacyMousePosition(params: object, metrics: LegacyMetrics): Record<string, unknown> {
  const input = params as Record<string, unknown>;
  const zoom = metrics.visualViewport?.zoom ?? 1;
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('Invalid mouse input zoom');
  return {
    ...input,
    ...(typeof input.x === 'number' ? { x: input.x * zoom } : {}),
    ...(typeof input.y === 'number' ? { y: input.y * zoom } : {}),
  };
}

/** The old screenshot clip uses device-independent pixels too; the layer and its masking always use CSS pixels. */
export function legacyScreenshotClip(params: object, metrics: LegacyMetrics): Record<string, unknown> {
  const input = params as Record<string, unknown>;
  const clip = input.clip as Record<string, unknown> | undefined;
  if (!clip) return input;
  const zoom = metrics.visualViewport?.zoom ?? 1;
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('Invalid screenshot zoom');
  return {
    ...input,
    clip: { ...clip, ...Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number(clip[key]) * zoom])) },
  };
}

export function normalizeLayoutMetrics(
  metrics: LegacyMetrics,
  scale = metrics.visualViewport?.zoom ?? 1,
): LegacyMetrics {
  if (metrics.cssLayoutViewport && metrics.cssContentSize) return metrics;
  if (!metrics.layoutViewport || !metrics.contentSize) throw new Error('Page.getLayoutMetrics returned no layout');
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid layout metric scale');
  const layout = metrics.layoutViewport;
  const content = metrics.contentSize;
  const visual = metrics.visualViewport;
  return {
    ...metrics,
    cssLayoutViewport: {
      pageX: layout.pageX / scale,
      pageY: layout.pageY / scale,
      clientWidth: layout.clientWidth / scale,
      clientHeight: layout.clientHeight / scale,
    },
    cssContentSize: {
      x: content.x / scale,
      y: content.y / scale,
      width: content.width / scale,
      height: content.height / scale,
    },
    ...(visual
      ? {
          cssVisualViewport: {
            ...visual,
            pageX: visual.pageX / scale,
            pageY: visual.pageY / scale,
            clientWidth: visual.clientWidth / scale,
            clientHeight: visual.clientHeight / scale,
            offsetX: visual.offsetX / scale,
            offsetY: visual.offsetY / scale,
          },
        }
      : {}),
  };
}
