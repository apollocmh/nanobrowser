import { subscribeInputEvents, subscribeScreenshotDecorations } from '@src/browser-control';
import type { InputEvent, InputPhase } from '@src/browser-control';
import { settingsStorage } from '@src/store/settings';

export interface CursorUpdate {
  epoch: number;
  sequence: number;
  state: 'input' | 'hidden' | 'visible' | 'off';
  x?: number;
  y?: number;
  type?: string;
  buttons?: number;
  phase?: InputPhase;
  hidden?: boolean;
}

export interface CursorPorts {
  enabled(): Promise<boolean>;
  inject(tabId: number, update: CursorUpdate, documentId?: string): Promise<void>;
}

interface TabCursor {
  epoch: number;
  documentId?: string;
  latest: number;
  hidden: number;
  active: boolean;
  tail: Promise<void>;
}

/** Ordered, disposable page decorations. Coordinates always come from the real CDP input parameters. */
export class PageCursor {
  #tabs = new Map<number, TabCursor>();
  #epoch = Date.now();
  constructor(private readonly ports: CursorPorts) {}

  #tab(tabId: number): TabCursor {
    let tab = this.#tabs.get(tabId);
    if (!tab) {
      tab = { epoch: ++this.#epoch, latest: 0, hidden: 0, active: false, tail: Promise.resolve() };
      this.#tabs.set(tabId, tab);
    }
    return tab;
  }

  #enqueue(tabId: number, tab: TabCursor, update: CursorUpdate): Promise<void> {
    const task = tab.tail
      .catch(() => undefined)
      .then(async () => {
        if (this.#tabs.get(tabId) !== tab) return;
        // Once a capture is pending, queued input must not unhide the decoration.
        const next = update.state === 'input' ? { ...update, hidden: tab.hidden > 0 } : update;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.ports.inject(tabId, next, tab.documentId),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Cursor injection timed out')), 500);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
    tab.tail = task;
    return task;
  }

  async input(event: InputEvent): Promise<void> {
    if (event.method !== 'Input.dispatchMouseEvent') return;
    const type = String(event.params.type ?? '');
    // Only clicks place the marker. Movement and scrolling must not leave a path across the page.
    if (type !== 'mousePressed' && type !== 'mouseReleased') return;
    const x = event.params.x;
    const y = event.params.y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const tab = this.#tab(event.tabId);
    if (!(await this.ports.enabled()) || this.#tabs.get(event.tabId) !== tab) return;
    // A late completion from an old document or a stopped run cannot recreate its cursor.
    if (!tab.active && event.phase !== 'pending') return;
    if (event.sequence < tab.latest) return;
    tab.latest = event.sequence;
    tab.active = true;
    await this.#enqueue(event.tabId, tab, {
      state: 'input',
      epoch: tab.epoch,
      sequence: event.sequence,
      x,
      y,
      type,
      buttons: typeof event.params.buttons === 'number' ? event.params.buttons : undefined,
      phase: event.phase,
    });
  }

  async hide(tabId: number): Promise<() => Promise<void>> {
    const tab = this.#tabs.get(tabId);
    if (!tab) return async () => undefined;
    tab.hidden++;
    try {
      if (tab.active) await this.#enqueue(tabId, tab, { state: 'hidden', epoch: tab.epoch, sequence: tab.latest });
    } catch (error) {
      tab.hidden--;
      throw error;
    }
    let restored = false;
    return async () => {
      if (restored) return;
      restored = true;
      tab.hidden--;
      if (this.#tabs.get(tabId) !== tab || tab.hidden || !tab.active) return;
      await this.#enqueue(tabId, tab, { state: 'visible', epoch: tab.epoch, sequence: tab.latest }).catch(
        () => undefined,
      );
    };
  }

  async clear(tabId: number, documentId?: string): Promise<void> {
    const old = this.#tabs.get(tabId);
    this.#tabs.delete(tabId);
    const tab = this.#tab(tabId);
    tab.documentId = documentId;
    // Old queued operations see a different record and are discarded; wait for any dispatched injection first.
    if (old) await old.tail.catch(() => undefined);
    await this.#enqueue(tabId, tab, { state: 'off', epoch: tab.epoch, sequence: 0 }).catch(() => undefined);
  }

  async settingChanged(): Promise<void> {
    if (await this.ports.enabled()) return;
    await Promise.all([...this.#tabs.keys()].map(tabId => this.clear(tabId)));
  }

  /** A closed tab needs no injection and must not retain a queued record. */
  forget(tabId: number): void {
    this.#tabs.delete(tabId);
  }
}

/** Entirely self-contained: serialized by scripting.executeScript into the extension's isolated world. */
export function setCursor(update: CursorUpdate): void {
  const key = '__nbVirtualCursor';
  // Keep a tombstone even after removing the DOM. A late injection from the old document/run must not recreate it.
  const epochs = globalThis as unknown as { __nbVirtualCursorEpoch?: number };
  if (update.epoch < (epochs.__nbVirtualCursorEpoch ?? 0)) return;
  epochs.__nbVirtualCursorEpoch = update.epoch;
  type State = {
    epoch: number;
    sequence: number;
    host: HTMLElement;
    pointer: HTMLElement;
    hidden: boolean;
    timer: ReturnType<typeof setInterval>;
    onHide: () => void;
  };
  const globals = globalThis as unknown as Record<string, State | undefined>;
  let state = globals[key];
  if (state && update.epoch < state.epoch) return;
  const remove = () => {
    const current = globals[key];
    if (!current) return;
    clearInterval(current.timer);
    removeEventListener('pagehide', current.onHide);
    current.host.remove();
    globals[key] = undefined;
  };
  if (update.state === 'off') return remove();
  if (state && update.epoch !== state.epoch) {
    remove();
    state = undefined;
  }
  // Hide/restore is also used when the setting is off: never create a decoration during a screenshot.
  if (!state && update.state !== 'input') return;
  if (!state || !state.host.isConnected) {
    remove();
    const host = document.createElement('div');
    host.setAttribute('data-nanobrowser-cursor', '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'all:initial;position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;contain:strict';
    // Page styles such as `div { pointer-events:auto !important }` cannot turn the host into a hit target.
    // `all` is a shorthand: marking it important would reset those explicit properties, pointer-events included.
    for (let i = 0; i < host.style.length; i++) {
      const name = host.style.item(i);
      if (name === 'all') continue;
      host.style.setProperty(name, host.style.getPropertyValue(name), 'important');
    }
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML =
      '<style>' +
      ':host{pointer-events:none}' +
      '.pointer{position:absolute;left:0;top:0;width:26px;height:26px;pointer-events:none;filter:drop-shadow(0 2px 4px rgba(3,20,45,.45));transform-origin:2px 2px;transition:opacity .12s ease,transform .08s ease;will-change:left,top}' +
      '.pointer svg{display:block;width:100%;height:100%;overflow:visible}' +
      '.pointer path{fill:#1779dc;stroke:#fff;stroke-width:1.5;stroke-linejoin:round;paint-order:stroke fill}' +
      '.pointer.pending{opacity:.72}' +
      '.pointer.unknown path,.pointer.failed path{fill:#c47b12}' +
      '.pointer.held{transform:scale(.86)}' +
      '.click-ring{position:absolute;left:1px;top:1px;width:8px;height:8px;margin:-4px 0 0 -4px;border:2px solid rgba(23,121,220,.85);border-radius:50%;opacity:0;pointer-events:none}' +
      '.pointer.click .click-ring{animation:clickRing .5s ease-out}' +
      '.pointer.failed .click-ring,.pointer.unknown .click-ring{border-color:rgba(196,123,18,.9)}' +
      '@keyframes clickRing{0%{opacity:.9;transform:scale(.3)}100%{opacity:0;transform:scale(3.6)}}' +
      '</style>' +
      // A single pointer at the last click; its tip sits on the click coordinates.
      '<div class="pointer"><span class="click-ring"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 1v18.4l4.9-4.2 3 6.5 3.3-1.5-3.1-6.6 6.4.4z"/></svg></div>';
    document.documentElement.appendChild(host);
    const onHide = () => remove();
    addEventListener('pagehide', onHide);
    const timer = setInterval(() => {
      if (!globalThis.chrome?.runtime?.id) remove();
    }, 2000);
    state = {
      epoch: update.epoch,
      sequence: 0,
      host,
      pointer: root.querySelector('.pointer') as HTMLElement,
      hidden: false,
      timer,
      onHide,
    };
    globals[key] = state;
  }
  if (update.state === 'hidden' || update.state === 'visible') {
    state.hidden = update.state === 'hidden';
    state.host.style.setProperty('display', state.hidden ? 'none' : 'block', 'important');
    return;
  }
  if (update.sequence < state.sequence) return;
  if (update.hidden !== undefined) {
    state.hidden = update.hidden;
    state.host.style.setProperty('display', state.hidden ? 'none' : 'block', 'important');
  }
  state.sequence = update.sequence;
  if (typeof update.x !== 'number' || typeof update.y !== 'number') return;
  state.pointer.style.left = `${update.x}px`;
  state.pointer.style.top = `${update.y}px`;
  const pressed = update.type === 'mousePressed' || (update.buttons ?? 0) !== 0;
  const clicked = update.type === 'mouseReleased' && update.phase === 'confirmed';
  state.pointer.className = `pointer ${update.phase ?? ''}${pressed ? ' held' : ''}${clicked ? ' click' : ''}`;
}

export async function injectCursor(tabId: number, update: CursorUpdate, documentId?: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: documentId ? { tabId, documentIds: [documentId] } : { tabId },
    func: setCursor,
    args: [update],
    injectImmediately: true,
  });
}

export const pageCursor = new PageCursor({
  enabled: async () => (await settingsStorage.get())?.virtualMouse !== false,
  inject: injectCursor,
});

/** Register synchronously at worker start, including test-panel operations on unscoped tabs. */
export function listenForCursor(): void {
  subscribeInputEvents(event => {
    void pageCursor.input(event).catch(() => undefined);
  });
  subscribeScreenshotDecorations(tabId => pageCursor.hide(tabId));
  chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId === 0) void pageCursor.clear(details.tabId, details.documentId);
  });
  chrome.debugger.onDetach.addListener(source => {
    if (source.tabId !== undefined) void pageCursor.clear(source.tabId);
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    pageCursor.forget(tabId);
  });
  settingsStorage.subscribe(() => {
    void pageCursor.settingChanged().catch(() => undefined);
  });
}
