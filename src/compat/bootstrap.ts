import { brand } from '@src/brand';
import { installRuntimeCompatibility } from './runtime';
import { installLegacyPanel } from './panel';

installRuntimeCompatibility();

/** Convert callback APIs before application modules capture a namespace. Explicit callbacks keep native semantics. */
export function installChromeCompatibility(api: typeof chrome): void {
  const wrap = (namespace: unknown, names: string[]) => {
    if (!namespace) return;
    const record = namespace as Record<string, unknown>;
    for (const name of names) {
      const original = record[name] as ((...args: unknown[]) => unknown) & { __nbPromise?: boolean };
      if (typeof original !== 'function' || original.__nbPromise) continue;
      const wrapped = (...args: unknown[]) => {
        if (typeof args[args.length - 1] === 'function') return original.apply(namespace, args);
        return new Promise((resolve, reject) => {
          try {
            original.apply(namespace, [
              ...args,
              (...results: unknown[]) => {
                const error = api.runtime.lastError;
                if (error) reject(new Error(error.message || 'Chrome extension API failed'));
                else resolve(results.length > 1 ? results : results[0]);
              },
            ]);
          } catch (error) {
            reject(error);
          }
        });
      };
      Object.defineProperty(wrapped, '__nbPromise', { value: true });
      record[name] = wrapped;
    }
  };
  wrap(api.runtime, ['sendMessage', 'openOptionsPage', 'setUninstallURL', 'getPlatformInfo']);
  wrap(api.tabs, [
    'get',
    'getCurrent',
    'query',
    'create',
    'update',
    'remove',
    'move',
    'reload',
    'captureVisibleTab',
    'setZoom',
    'getZoom',
    'group',
    'ungroup',
    'executeScript',
    'sendMessage',
  ]);
  wrap(api.windows, ['get', 'getCurrent', 'getAll', 'create', 'update', 'remove']);
  wrap(api.debugger, ['attach', 'detach', 'sendCommand', 'getTargets']);
  wrap(api.permissions, ['contains', 'request', 'remove', 'getAll']);
  wrap(api.notifications, ['create', 'clear', 'getAll', 'update']);
  wrap(api.downloads, ['download', 'search', 'erase', 'removeFile']);
  // Chromium 80 downloads.open is a void, one-argument API. Appending a callback fails signature validation.
  if (api.runtime.getManifest().manifest_version === 2 && api.downloads?.open) {
    const open = api.downloads.open as typeof api.downloads.open & { __nbPromise?: boolean };
    if (!open.__nbPromise) {
      const wrapped = (downloadId: number) => {
        try {
          return Promise.resolve(Reflect.apply(open, api.downloads, [downloadId]));
        } catch (error) {
          return Promise.reject(error);
        }
      };
      Object.defineProperty(wrapped, '__nbPromise', { value: true });
      api.downloads.open = wrapped as typeof api.downloads.open;
    }
  } else wrap(api.downloads, ['open']);
  wrap(api.contextMenus, ['removeAll', 'remove', 'update']);
  wrap(api.commands, ['getAll']);
  wrap(api.tabGroups, ['get', 'query', 'update', 'move']);
  wrap(api.webNavigation, ['getAllFrames', 'getFrame']);
  wrap(api.management, ['getPermissionWarningsByManifest']);
  wrap(api.alarms, ['get', 'getAll', 'clear', 'clearAll']);
  for (const area of [api.storage?.local, api.storage?.sync, api.storage?.session])
    wrap(area, ['get', 'set', 'remove', 'clear', 'getBytesInUse']);
  if (!api.action && api.browserAction)
    (api as unknown as { action: typeof api.action }).action = api.browserAction as unknown as typeof api.action;
  wrap(api.action, [
    'setBadgeText',
    'setBadgeBackgroundColor',
    'setTitle',
    'setIcon',
    'getBadgeText',
    'enable',
    'disable',
    'getUserSettings',
  ]);
  // alarms.create had no callback until Chrome 111. Do not append an unsupported argument in MV2.
  if (api.runtime.getManifest().manifest_version === 2 && api.alarms?.create) {
    const create = api.alarms.create.bind(api.alarms);
    api.alarms.create = ((...args: Parameters<typeof create>) => {
      create(...args);
      return Promise.resolve();
    }) as typeof create;
  }
  if (!api.storage.session) installSessionStorage(api);
  if (!api.scripting) {
    const executeScript = async (injection: {
      world?: string;
      func?: (...args: unknown[]) => unknown;
      files?: string[];
      target: chrome.scripting.InjectionTarget;
      args?: unknown[];
    }) => {
      if (injection.world && injection.world !== 'ISOLATED')
        throw new Error('Chrome 80 supports isolated-world injection only');
      if (!injection.func || injection.files?.length)
        throw new Error('Legacy injection requires a serializable function');
      if (injection.target.documentIds?.length) throw new Error('Chrome 80 cannot address an injection by document ID');
      const tabId = injection.target.tabId;
      const frames = injection.target.allFrames
        ? ((await api.webNavigation.getAllFrames({ tabId })) ?? []).map(frame => frame.frameId)
        : (injection.target.frameIds ?? [0]);
      if (!frames.length) throw new Error('No frame is available for legacy injection');
      return Promise.all(
        frames.map(async frameId => {
          // tabs.executeScript does not await Promises. An isolated-world reply keeps async decorations ordered with CDP.
          const id = crypto.randomUUID();
          let finish: (() => void) | undefined;
          const result = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
              finish?.();
              reject(new Error('Legacy injection timed out'));
            }, 5000);
            const listener = (
              message: { type?: string; id?: string; ok?: boolean; value?: unknown; error?: string },
              sender: chrome.runtime.MessageSender,
              reply: (value?: unknown) => void,
            ) => {
              if (
                message?.type !== '__nb_injection_result' ||
                message.id !== id ||
                sender.id !== api.runtime.id ||
                sender.tab?.id !== tabId ||
                sender.frameId !== frameId
              )
                return;
              finish?.();
              reply(null);
              if (message.ok) resolve(message.value);
              else reject(new Error(message.error || 'Legacy injection failed'));
            };
            finish = () => {
              clearTimeout(timer);
              api.runtime.onMessage.removeListener(listener);
            };
            api.runtime.onMessage.addListener(listener);
          });
          const code = `void Promise.resolve().then(() => (${injection.func!.toString()})(...${JSON.stringify(injection.args ?? [])})).then(value => chrome.runtime.sendMessage({type:'__nb_injection_result',id:${JSON.stringify(id)},ok:true,value}),error => chrome.runtime.sendMessage({type:'__nb_injection_result',id:${JSON.stringify(id)},ok:false,error:String(error)}));`;
          try {
            // Register the reply before dispatch, then await both the injection acknowledgement and its actual result.
            const [, value] = await Promise.all([
              api.tabs.executeScript(tabId, { code, frameId, runAt: 'document_start', matchAboutBlank: true }),
              result,
            ]);
            return { frameId, result: value };
          } finally {
            finish?.();
          }
        }),
      );
    };
    (api as unknown as { scripting: unknown }).scripting = { executeScript };
  }
  installLegacyPanel(api);
}

interface SessionOwner {
  __nbSession?: Record<string, unknown>;
  __nbSessionListeners?: Set<
    (changes: Record<string, chrome.storage.StorageChange>, area: chrome.storage.AreaName) => void
  >;
}
function installSessionStorage(api: typeof chrome): void {
  // A persistent MV2 background document owns the data for all extension windows. It disappears with the browser.
  const owner = (api.extension.getBackgroundPage() ?? globalThis) as unknown as SessionOwner;
  const data = (owner.__nbSession ??= {});
  const listeners = (owner.__nbSessionListeners ??= new Set());
  const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  const notify = (changes: Record<string, chrome.storage.StorageChange>) => {
    if (Object.keys(changes).length) listeners.forEach(listener => listener(copy(changes), 'session'));
  };
  const event = api.storage.onChanged;
  const add = event.addListener.bind(event);
  const remove = event.removeListener.bind(event);
  const ownListeners = new Set<Parameters<typeof add>[0]>();
  event.addListener = listener => {
    listeners.add(listener);
    ownListeners.add(listener);
    add(listener);
  };
  event.removeListener = listener => {
    listeners.delete(listener);
    ownListeners.delete(listener);
    remove(listener);
  };
  if (typeof window !== 'undefined')
    window.addEventListener('unload', () => {
      ownListeners.forEach(listener => listeners.delete(listener));
    });
  const session = {
    async get(keys: string | string[] | Record<string, unknown> | null = null) {
      if (keys === null) return copy(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out: Record<string, unknown> = {};
      for (const key of list)
        if (key in data) out[key] = copy(data[key]);
        else if (typeof keys === 'object' && !Array.isArray(keys)) out[key] = copy(keys[key]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: copy(data[key]), newValue: copy(value) };
        data[key] = copy(value);
      }
      notify(changes);
    },
    async remove(keys: string | string[]) {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const key of typeof keys === 'string' ? [keys] : keys)
        if (key in data) {
          changes[key] = { oldValue: copy(data[key]) };
          delete data[key];
        }
      notify(changes);
    },
    async clear() {
      await session.remove(Object.keys(data));
    },
    async getBytesInUse(keys: string | string[] | null = null) {
      return new TextEncoder().encode(JSON.stringify(await session.get(keys))).length;
    },
  };
  Object.values(session).forEach(method => Object.defineProperty(method, '__nbPromise', { value: true }));
  (api.storage as unknown as { session: unknown }).session = session;
}

if (globalThis.chrome?.runtime?.id) {
  installChromeCompatibility(chrome);
  chrome.permissions?.onAdded.addListener(() => installChromeCompatibility(chrome));
}

if (typeof document !== 'undefined') {
  document.title = document.title.replace(/Nanobrowser/g, brand.name);
  const detectGap = () => {
    const test = document.createElement('div');
    test.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden;';
    test.append(document.createElement('div'), document.createElement('div'));
    document.body.append(test);
    document.documentElement.classList.toggle('no-flex-gap', test.scrollHeight !== 1);
    test.remove();
  };
  if (document.body) detectGap();
  else document.addEventListener('DOMContentLoaded', detectGap, { once: true });
}
