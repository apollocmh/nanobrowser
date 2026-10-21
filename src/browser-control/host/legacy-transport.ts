// A single-tab transport, matching Puppeteer's ExtensionTransport target facade, with old CDP envelopes.
// The facade represents the one real debugger attachment; it does not invent frames or page state.
import { legacyChannel } from './legacy-cdp';

const page = { targetId: 'pageTargetId', type: 'page', title: '', url: 'about:blank', attached: true };
const tab = { targetId: 'tabTargetId', type: 'tab', title: '', url: 'about:blank', attached: true };

export class LegacyExtensionTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;
  #off: () => void;
  #closed = false;
  #channel;

  static async connectTab(tabId: number): Promise<LegacyExtensionTransport> {
    await chrome.debugger.attach({ tabId }, '1.3');
    return new LegacyExtensionTransport(tabId);
  }

  constructor(readonly tabId: number) {
    this.#channel = legacyChannel(tabId);
    this.#off = this.#channel.on((sessionId, method, params) => {
      this.#emit({ sessionId: sessionId ?? 'pageTargetSessionId', method, params });
    });
  }

  #emit(message: object): void {
    setTimeout(() => {
      if (!this.#closed) this.onmessage?.(JSON.stringify(message));
    }, 0);
  }

  send(message: string): void {
    const request = JSON.parse(message);
    const { id, sessionId, method } = request;
    const reply = (result: unknown) => this.#emit({ id, sessionId, result });
    if (method === 'Target.getBrowserContexts') return reply({ browserContextIds: [] });
    if (method === 'Browser.getVersion') return reply({ product: navigator.userAgent, protocolVersion: '1.3', userAgent: navigator.userAgent });
    if (method === 'Target.setDiscoverTargets') {
      this.#emit({ method: 'Target.targetCreated', params: { targetInfo: tab } });
      this.#emit({ method: 'Target.targetCreated', params: { targetInfo: page } });
      return reply({});
    }
    if (method === 'Target.setAutoAttach' && (!sessionId || sessionId === 'tabTargetSessionId')) {
      this.#emit({
        ...(sessionId ? { sessionId } : {}),
        method: 'Target.attachedToTarget',
        params: {
          targetInfo: sessionId ? page : tab,
          sessionId: sessionId ? 'pageTargetSessionId' : 'tabTargetSessionId',
          waitingForDebugger: false,
        },
      });
      return reply({});
    }
    const actualSession = sessionId === 'pageTargetSessionId' ? undefined : sessionId;
    void this.#channel.send(actualSession, method, request.params).then(reply, error => {
      this.#emit({ id, sessionId, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#off();
    this.#channel.close();
    void chrome.debugger.detach({ tabId: this.tabId }).catch(() => undefined);
  }
}
