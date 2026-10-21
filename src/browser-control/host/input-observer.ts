/** Receipts from the one raw input channel. Observers never dispatch input or change its result. */
export type InputPhase = 'pending' | 'confirmed' | 'unknown' | 'failed';
export interface InputEvent {
  tabId: number;
  method: string;
  params: Readonly<Record<string, unknown>>;
  phase: InputPhase;
  sequence: number;
}

const listeners = new Set<(event: InputEvent) => void>();
let sequence = 0;

/** Keep the returned sequence for the terminal receipt; concurrent completions must not move the cursor back. */
export function dispatchInputEvent(event: Omit<InputEvent, 'sequence'> & { sequence?: number }): InputEvent {
  const receipt = { ...event, params: { ...event.params }, sequence: event.sequence ?? ++sequence };
  for (const listener of listeners) {
    try {
      listener(receipt);
    } catch {
      // A decoration cannot fail a browser operation.
    }
  }
  return receipt;
}

export function subscribeInputEvents(listener: (event: InputEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type Restore = () => Promise<void>;
const decorations = new Set<(tabId: number) => Promise<Restore>>();

/** Each subscriber hides its decoration before capture and returns its matching restore operation. */
export function subscribeScreenshotDecorations(hide: (tabId: number) => Promise<Restore>): () => void {
  decorations.add(hide);
  return () => decorations.delete(hide);
}

/** Used by the raw screenshot channel, including screenshots taken internally by the layer. */
export async function aroundScreenshot<T>(tabId: number, capture: () => Promise<T>): Promise<T> {
  const restores: Restore[] = [];
  let value: T | undefined;
  let failed = false;
  let failure: unknown;
  try {
    for (const hide of decorations) restores.push(await hide(tabId));
    value = await capture();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    for (const restore of restores.reverse()) {
      try {
        await restore();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }
  if (failed) throw failure;
  return value as T;
}
