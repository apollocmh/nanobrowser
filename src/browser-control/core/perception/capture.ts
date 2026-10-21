// Perception tier 1 capture: Accessibility.getFullAXTree per frame, on the frame's session.
// Observation is read-only: nothing here changes the page.
import type { CdpPort, FrameRecord, SessionId, TopologyPort } from '../ports';
import type { AXNode } from './ax';
import { LAYOUT_STYLES } from './layout';
import type { RawDocument, RawSnapshot } from './layout';
import { isDocumentRole, roleOf, valueOf } from './ax';

/** Limits: 20 frames, depth 5, minimum 10×10 px, ad frames skipped; 10 s per capture command. */
export const FRAME_LIMITS = { maxFrames: 20, maxDepth: 5, minSize: 10 };
export const CAPTURE_COMMAND_TIMEOUT_MS = 10_000;
const MAX_FIELD_LOOKUPS = 300;
export const LEGACY_AX_LIMITS = { maxQueries: 1000, maxNodes: 10000, timeoutMs: 10000 };

/** DOM facts about a text field, read to decide masking (input type, autocomplete, name). */
export interface FieldFacts {
  tag: string;
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
}

export interface FrameCapture extends FrameRecord {
  /** The owner iframe element in the parent frame's document; null for the main frame. */
  ownerBackendNodeId: number | null;
  status: 'captured' | 'skipped' | 'failed';
  reason?: string;
  nodes: AXNode[];
  /** Keyed by backend node ID. */
  fields: Record<string, FieldFacts>;
}

export interface Viewport {
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
  /**
   * Device pixels per CSS pixel. The layout snapshot's bounds and scroll offsets are in device pixels; everything
   * else here is in CSS pixels. Absent in captures recorded before it was read: 1.
   */
  scale?: number;
}

/**
 * Device pixels per CSS pixel, from the two content sizes of `Page.getLayoutMetrics` (the deprecated one is in device
 * pixels). The longer side gives the better ratio.
 */
export function deviceScale(metrics: {
  contentSize?: { width: number; height: number };
  cssContentSize: { width: number; height: number };
}): number {
  const device = metrics.contentSize;
  const css = metrics.cssContentSize;
  if (!device) return 1;
  const ratio = css.height >= css.width ? device.height / css.height : device.width / css.width;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export interface Capture {
  tabId: number;
  url: string;
  title: string;
  frames: FrameCapture[];
  viewport: Viewport | null;
  /** Tier 2: the raw layout snapshot of each session (key: session ID, '' for the root), when it was captured. */
  layout?: Record<string, RawSnapshot>;
  /** Why tier 2 is missing, when it is. */
  layoutError?: string;
  ms: number;
}

/** Domains the layer enables once per session and never disables. */
export async function enableDomains(cdp: CdpPort, sessionId: SessionId, enabled: Set<string>): Promise<void> {
  const key = sessionId ?? '';
  if (enabled.has(key)) return;
  await Promise.all([cdp.send(sessionId, 'DOM.enable'), cdp.send(sessionId, 'Accessibility.enable')]);
  enabled.add(key);
}

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

function attributes(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; list && i + 1 < list.length; i += 2) out[list[i].toLowerCase()] = list[i + 1];
  return out;
}

async function fieldFacts(cdp: CdpPort, sessionId: SessionId, nodes: AXNode[]): Promise<Record<string, FieldFacts>> {
  const targets = nodes
    // A listbox has no value, but its attributes decide whether its options are masked (outline.ts).
    .filter(
      n => !n.ignored && n.backendDOMNodeId && ((FIELD_ROLES.has(roleOf(n)) && valueOf(n)) || roleOf(n) === 'listbox'),
    )
    .slice(0, MAX_FIELD_LOOKUPS);
  const out: Record<string, FieldFacts> = {};
  await Promise.all(
    targets.map(async n => {
      try {
        const { node } = await cdp.send<{ node: { nodeName: string; attributes?: string[] } }>(
          sessionId,
          'DOM.describeNode',
          { backendNodeId: n.backendDOMNodeId },
        );
        const a = attributes(node.attributes);
        out[String(n.backendDOMNodeId)] = {
          tag: node.nodeName.toLowerCase(),
          type: a.type?.toLowerCase(),
          autocomplete: a.autocomplete?.toLowerCase(),
          name: a.name,
          id: a.id,
        };
      } catch {
        // Unknown facts: the layout snapshot's attributes are used, or the value is masked (outline.ts).
      }
    }),
  );
  return out;
}

async function viewportOf(cdp: CdpPort): Promise<Viewport | null> {
  try {
    const m = await cdp.send<{
      cssLayoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
      cssContentSize: { width: number; height: number };
      contentSize?: { width: number; height: number };
    }>(undefined, 'Page.getLayoutMetrics');
    return {
      scrollX: m.cssLayoutViewport.pageX,
      scrollY: m.cssLayoutViewport.pageY,
      width: m.cssLayoutViewport.clientWidth,
      height: m.cssLayoutViewport.clientHeight,
      contentWidth: m.cssContentSize.width,
      contentHeight: m.cssContentSize.height,
      scale: deviceScale(m),
    };
  } catch {
    return null;
  }
}

/** Decides which frames are captured, before any AX call. */
async function planFrames(cdp: CdpPort, frames: FrameRecord[]): Promise<FrameCapture[]> {
  const byId = new Map(frames.map(f => [f.frameId, f]));
  const planned = new Map<string, FrameCapture>();
  let captured = 0;
  for (const frame of frames) {
    const base: FrameCapture = { ...frame, ownerBackendNodeId: null, status: 'captured', nodes: [], fields: {} };
    planned.set(frame.frameId, base);
    if (!frame.parentFrameId) {
      captured++;
      continue;
    }
    const parent = planned.get(frame.parentFrameId);
    const parentRecord = byId.get(frame.parentFrameId);
    const skip = (reason: string) => Object.assign(base, { status: 'skipped', reason });
    if (!parent || !parentRecord) {
      skip('its parent frame is unknown');
      continue;
    }
    try {
      const { backendNodeId } = await cdp.send<{ backendNodeId: number }>(parentRecord.sessionId, 'DOM.getFrameOwner', {
        frameId: frame.frameId,
      });
      base.ownerBackendNodeId = backendNodeId;
    } catch {
      // The owner is not in the parent's DOM any more; the frame is going away.
    }
    if (parent.status !== 'captured') {
      skip('inside a frame that was not captured');
      continue;
    }
    if (frame.adFrame) {
      skip('ad frame (skipped by policy)');
      continue;
    }
    if (frame.depth > FRAME_LIMITS.maxDepth) {
      skip(`nested deeper than ${FRAME_LIMITS.maxDepth}`);
      continue;
    }
    if (base.ownerBackendNodeId === null) {
      skip('its iframe element is gone');
      continue;
    }
    try {
      const { model } = await cdp.send<{ model: { width: number; height: number } }>(
        parentRecord.sessionId,
        'DOM.getBoxModel',
        { backendNodeId: base.ownerBackendNodeId },
      );
      if (model.width < FRAME_LIMITS.minSize || model.height < FRAME_LIMITS.minSize) {
        skip(`smaller than ${FRAME_LIMITS.minSize}×${FRAME_LIMITS.minSize} px`);
        continue;
      }
    } catch {
      skip('not rendered');
      continue;
    }
    if (captured >= FRAME_LIMITS.maxFrames) {
      skip(`more than ${FRAME_LIMITS.maxFrames} frames`);
      continue;
    }
    captured++;
  }
  return [...planned.values()];
}

export interface CaptureState {
  /** Sessions whose domains are enabled; kept per attachment. */
  enabledSessions: Set<string>;
  /** Test hook: make the layout snapshot fail, to check the tier 1 fallback (fixture set D). */
  failLayout?: boolean;
}

/** Tier 2: DOMSnapshot.captureSnapshot per session that has a captured frame. */
async function captureLayout(
  cdp: CdpPort,
  frames: FrameCapture[],
  state: CaptureState,
): Promise<{ layout?: Record<string, RawSnapshot>; error?: string }> {
  if (state.failLayout) return { error: 'the layout snapshot failed (test hook)' };
  const sessions = [...new Set(frames.filter(f => f.status === 'captured').map(f => f.sessionId))];
  try {
    const entries = await Promise.all(
      sessions.map(async sessionId => {
        const snapshot = await cdp.send<RawSnapshot>(
          sessionId,
          'DOMSnapshot.captureSnapshot',
          { computedStyles: [...LAYOUT_STYLES], includeDOMRects: true, includePaintOrder: false },
          CAPTURE_COMMAND_TIMEOUT_MS,
        );
        return [sessionId ?? '', snapshot] as const;
      }),
    );
    return { layout: Object.fromEntries(entries) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Only descend inside this document. Partial AX responses contain ancestors from outside it as well. */
export function scopeAXTree(nodes: AXNode[], rootId: string, domIds?: Set<number>): AXNode[] {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const out: AXNode[] = [];
  const seen = new Set<string>();
  const queue: Array<{ id: string; parentId?: string }> = [{ id: rootId }];
  for (let i = 0; i < queue.length; i++) {
    const { id, parentId } = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node || (id !== rootId && isDocumentRole(roleOf(node)))) continue;
    if (domIds && node.backendDOMNodeId && !domIds.has(node.backendDOMNodeId)) continue;
    const children = (node.childIds ?? []).filter(childId => {
      const child = byId.get(childId);
      return (
        child &&
        !isDocumentRole(roleOf(child)) &&
        (!domIds || !child.backendDOMNodeId || domIds.has(child.backendDOMNodeId))
      );
    });
    out.push({ ...node, parentId, childIds: children });
    queue.push(...children.map(childId => ({ id: childId, parentId: id })));
  }
  return out;
}

/**
 * Chrome 80 silently ignores getFullAXTree.frameId. Resolve the document by browser DOM identity, then expand its
 * actual AX nodes. The protocol still computes every role and accessible name; layout never substitutes for AX.
 */
export async function capturePartialDocumentAX(
  cdp: CdpPort,
  sessionId: SessionId,
  documentBackendId: number,
  domIds?: Set<number>,
): Promise<AXNode[]> {
  const nodes = new Map<string, AXNode>();
  // Accessibility.enable in Chromium 80 retains an AXContext only for the session's main document. Same-process
  // child documents get a temporary context per partial query, so their AX IDs change between responses. Backend
  // DOM identity is stable: keep the first real AX ID seen for each DOM node and translate subsequent edges to it.
  const byBackend = new Map<number, string>();
  const aliases = new Map<string, string>();
  const excluded = new Set<string>();
  const expanded = new Set<number>();
  const pending = [documentBackendId];
  const queued = new Set(pending);
  const deadline = performance.now() + LEGACY_AX_LIMITS.timeoutMs;
  let rootId: string | undefined;
  let queries = 0;
  while (pending.length) {
    if (queries + pending.length > LEGACY_AX_LIMITS.maxQueries || performance.now() >= deadline) {
      throw new Error('The frame accessibility capture exceeded its bounded query/time budget.');
    }
    const batch = pending.splice(0, 4);
    const responses = await Promise.all(
      batch.map(async backendNodeId => ({
        backendNodeId,
        response: await cdp.send<{ nodes: AXNode[] }>(
          sessionId,
          'Accessibility.getPartialAXTree',
          { backendNodeId, fetchRelatives: true },
          Math.max(1, deadline - performance.now()),
        ),
      })),
    );
    queries += batch.length;
    for (const { backendNodeId, response } of responses) {
      const inspected = response.nodes.find(node => node.backendDOMNodeId === backendNodeId);
      if (!inspected) throw new Error('The document/node disappeared during its accessibility capture.');
      for (const node of response.nodes) {
        const backend = node.backendDOMNodeId;
        if (backend && (!domIds || domIds.has(backend))) {
          if (!byBackend.has(backend)) byBackend.set(backend, node.nodeId);
          aliases.set(node.nodeId, byBackend.get(backend)!);
        }
      }
      if (backendNodeId === documentBackendId) {
        if (!isDocumentRole(roleOf(inspected)))
          throw new Error('The captured node is not the expected frame document.');
        rootId = aliases.get(inspected.nodeId) ?? inspected.nodeId;
      }
      for (const node of response.nodes) {
        if (domIds && node.backendDOMNodeId && !domIds.has(node.backendDOMNodeId)) {
          excluded.add(node.nodeId);
          continue;
        }
        const id = aliases.get(node.nodeId) ?? node.nodeId;
        const previous = nodes.get(id);
        const childIds = node.childIds?.map(child => aliases.get(child) ?? child);
        // Ancestors in a partial response list only the branch being inspected. They cannot replace a complete list.
        const children = expanded.has(node.backendDOMNodeId ?? -1)
          ? previous?.childIds
          : node === inspected
            ? childIds
            : [...new Set([...(previous?.childIds ?? []), ...(childIds ?? [])])];
        nodes.set(id, { ...previous, ...node, nodeId: id, childIds: children });
      }
      expanded.add(backendNodeId);
      if (nodes.size > LEGACY_AX_LIMITS.maxNodes)
        throw new Error('The frame accessibility capture exceeded its node budget.');
    }
    if (!rootId) throw new Error('The frame document has no accessibility root.');
    // Scope first: ancestors and child frame documents must never be expanded as part of this frame.
    for (const node of scopeAXTree([...nodes.values()], rootId, domIds)) {
      const backend = node.backendDOMNodeId;
      if (
        backend &&
        !expanded.has(backend) &&
        !queued.has(backend) &&
        (nodes.get(node.nodeId)?.childIds?.length ?? 0) > 0
      ) {
        pending.push(backend);
        queued.add(backend);
      }
    }
  }
  if (!rootId) throw new Error('The frame document has no accessibility root.');
  for (const node of scopeAXTree([...nodes.values()], rootId, domIds)) {
    if ((nodes.get(node.nodeId)?.childIds ?? []).some(id => !nodes.has(id) && !excluded.has(id))) {
      throw new Error('The frame accessibility subtree is incomplete; it was not reported as a full capture.');
    }
  }
  return scopeAXTree([...nodes.values()], rootId, domIds);
}

function snapshotDocument(snapshot: RawSnapshot | undefined, frameId: string): RawDocument | undefined {
  return snapshot?.documents.find(doc => snapshot.strings[doc.frameId] === frameId);
}

async function frameAX(
  cdp: CdpPort,
  frame: FrameCapture,
  frames: FrameCapture[],
  snapshot?: RawSnapshot,
): Promise<AXNode[]> {
  const doc = snapshotDocument(snapshot, frame.frameId);
  let documentBackendId = doc?.nodes.backendNodeId?.[doc.nodes.nodeType?.indexOf(9) ?? 0];
  const domIds = doc?.nodes.backendNodeId ? new Set(doc.nodes.backendNodeId) : undefined;
  const sameProcessChild =
    frame.parentFrameId && frames.find(f => f.frameId === frame.parentFrameId)?.sessionId === frame.sessionId;
  if (!documentBackendId && sameProcessChild && frame.ownerBackendNodeId) {
    const { node } = await cdp.send<{ node: { contentDocument?: { backendNodeId: number } } }>(
      frame.sessionId,
      'DOM.describeNode',
      { backendNodeId: frame.ownerBackendNodeId, depth: 0, pierce: true },
    );
    documentBackendId = node.contentDocument?.backendNodeId;
  }
  const { nodes } = await cdp.send<{ nodes: AXNode[] }>(
    frame.sessionId,
    'Accessibility.getFullAXTree',
    { frameId: frame.frameId },
    CAPTURE_COMMAND_TIMEOUT_MS,
  );
  const root = nodes.find(node => isDocumentRole(roleOf(node)));
  if (!root) throw new Error('The frame accessibility tree has no document root.');
  const matches = documentBackendId
    ? root.backendDOMNodeId === documentBackendId
    : root.frameId === frame.frameId || !sameProcessChild;
  if (matches) return scopeAXTree(nodes, root.nodeId, domIds);
  if (!documentBackendId)
    throw new Error('The protocol did not capture the requested frame and its document identity is unavailable.');
  return capturePartialDocumentAX(cdp, frame.sessionId, documentBackendId, domIds);
}

export async function captureTier1(
  tabId: number,
  cdp: CdpPort,
  topology: TopologyPort,
  state: CaptureState,
): Promise<Capture> {
  const start = performance.now();
  const frames = await topology.frames();
  await Promise.all([...new Set(frames.map(f => f.sessionId))].map(s => enableDomains(cdp, s, state.enabledSessions)));
  const planned = await planFrames(cdp, frames);
  const layout = await captureLayout(cdp, planned, state);
  await Promise.all(
    planned
      .filter(f => f.status === 'captured')
      .map(async frame => {
        try {
          const nodes = await frameAX(cdp, frame, planned, layout.layout?.[frame.sessionId ?? '']);
          frame.nodes = nodes;
          frame.fields = await fieldFacts(cdp, frame.sessionId, nodes);
        } catch (error) {
          frame.status = 'failed';
          frame.reason = error instanceof Error ? error.message : String(error);
        }
      }),
  );
  const viewport = await viewportOf(cdp);
  const main = planned[0];
  const root = main?.nodes.find(n => isDocumentRole(roleOf(n)));
  return {
    tabId,
    url: main?.url ?? '',
    title: typeof root?.name?.value === 'string' ? root.name.value : '',
    frames: planned,
    viewport,
    layout: layout.layout,
    layoutError: layout.error,
    ms: Math.round(performance.now() - start),
  };
}
