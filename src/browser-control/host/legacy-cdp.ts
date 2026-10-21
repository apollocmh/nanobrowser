// Chrome before 125 cannot address a child CDP session through chrome.debugger's target argument.
// This channel only translates protocol envelopes. Puppeteer remains the owner of the frame tree.
export function browserMajor(): number {
  return Number(/(?:Chrome|Chromium)\/(\d+)/.exec(globalThis.navigator?.userAgent ?? '')?.[1] ?? 125);
}

type EventListener = (sessionId: string | undefined, method: string, params: Record<string, unknown>) => void;
interface Pending {
  sessionId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const channels = new Map<number, LegacyCdpChannel>();

export function legacyChannel(tabId: number): LegacyCdpChannel {
  let channel = channels.get(tabId);
  if (!channel) {
    channel = new LegacyCdpChannel(tabId);
    channels.set(tabId, channel);
  }
  return channel;
}

export class LegacyCdpChannel {
  #closed = false;
  #next = 0;
  #parents = new Map<string, string | undefined>();
  #pending = new Map<number, Pending>();
  #listeners = new Set<EventListener>();

  constructor(readonly tabId: number) {
    chrome.debugger.onEvent.addListener(this.#event);
    chrome.debugger.onDetach.addListener(this.#detach);
  }

  on(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #event = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== this.tabId) return;
    this.#receive(undefined, method, (params ?? {}) as Record<string, unknown>);
  };

  #receive(sessionId: string | undefined, method: string, params: Record<string, unknown>): void {
    if (method === 'Target.receivedMessageFromTarget') {
      const childId = String(params.sessionId);
      let message;
      try {
        message = JSON.parse(String(params.message));
        if (!message || typeof message !== 'object' || Array.isArray(message) ||
          (message.id === undefined && typeof message.method !== 'string')) throw new Error('Invalid envelope');
      }
      catch {
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Invalid child protocol response'));
        }
        this.#pending.clear();
        return;
      }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (pending && pending.sessionId === childId) {
          this.#pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        }
      } else if (message.method) this.#receive(childId, message.method, message.params ?? {});
      return;
    }
    if (method === 'Target.attachedToTarget') this.#parents.set(String(params.sessionId), sessionId);
    if (method === 'Target.detachedFromTarget') {
      const removed = new Set([String(params.sessionId)]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [child, parent] of this.#parents) {
          if (parent && removed.has(parent) && !removed.has(child)) { removed.add(child); changed = true; }
        }
      }
      for (const child of removed) this.#parents.delete(child);
      for (const [id, pending] of this.#pending) {
        if (!removed.has(pending.sessionId)) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(new Error('Child session detached while handling command'));
      }
    }
    for (const listener of this.#listeners) listener(sessionId, method, params);
  }

  #detach = (source: chrome.debugger.Debuggee) => {
    if (source.tabId === this.tabId) this.close();
  };

  async send(sessionId: string | undefined, method: string, params: object = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.#closed) throw new Error('Debugger detached: protocol channel is closed');
    const adapted = { ...params } as Record<string, unknown>;
    if (method === 'Target.setAutoAttach') {
      adapted.flatten = false;
      delete adapted.filter;
    }
    if (method === 'Page.createIsolatedWorld' && 'grantUniversalAccess' in adapted) {
      adapted.grantUniveralAccess = adapted.grantUniversalAccess;
      delete adapted.grantUniversalAccess;
    }
    if (!sessionId) return chrome.debugger.sendCommand({ tabId: this.tabId }, method, adapted);
    if (!this.#parents.has(sessionId)) throw new Error(`Child session ${sessionId} is detached or unknown`);
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: child protocol response timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { sessionId, resolve, reject, timer });
      void this.send(this.#parents.get(sessionId), 'Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method, params: adapted }),
      }, timeoutMs).catch(error => {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    chrome.debugger.onEvent.removeListener(this.#event);
    chrome.debugger.onDetach.removeListener(this.#detach);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Debugger detached while handling command'));
    }
    this.#pending.clear();
    this.#parents.clear();
    this.#listeners.clear();
    channels.delete(this.tabId);
  }
}
