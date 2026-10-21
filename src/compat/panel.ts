interface LegacyPanel {
  path: string;
  windowId?: number;
  opening?: Promise<void>;
  closing?: Promise<void>;
}

interface ClosingWindow {
  promise: Promise<void>;
  finish(error?: Error, restore?: boolean): void;
}

interface LegacyPanels {
  __nbPanels?: Map<number, LegacyPanel>;
  __nbPanelClosures?: Map<number, ClosingWindow>;
}

/** A real per-tab companion window for browsers without the native side panel. */
export function installLegacyPanel(api: typeof chrome): void {
  // Chrome 114–124 exposes the namespace to MV2 too, but this package has no native sidePanel permission.
  // All MV2 builds consistently use the companion window, even when the browser exposes the newer namespace.
  if (
    api.runtime.getManifest().manifest_version !== 2 ||
    (api.sidePanel as typeof api.sidePanel & { __nbLegacy?: boolean })?.__nbLegacy
  )
    return;
  const owner = (api.extension.getBackgroundPage() ?? globalThis) as unknown as LegacyPanels;
  const panels = (owner.__nbPanels ??= new Map());
  const closures = (owner.__nbPanelClosures ??= new Map());
  const originalRemove = api.windows.remove.bind(api.windows);
  // Chrome 80 acknowledges windows.remove before the window actually closes. Invalidate the focus target before
  // dispatch and wait for onRemoved, otherwise an immediate open can successfully focus a doomed window.
  const remove = (windowId: number, callback?: () => void) => {
    if (!callback && closures.has(windowId)) return closures.get(windowId)!.promise;
    const affected = [...panels.entries()].filter(([, panel]) => panel.windowId === windowId);
    if (!affected.length) return callback ? originalRemove(windowId, callback) : originalRemove(windowId);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Explicit-callback callers do not consume this promise, but open still waits on it.
    void promise.catch(() => undefined);
    let settled = false;
    const closing: ClosingWindow = {
      promise,
      finish(error, restore = false) {
        clearTimeout(timer);
        // A timeout leaves the closing marker in place: opening must fail rather than create a duplicate window.
        if (!error || restore) {
          closures.delete(windowId);
          for (const [tabId, panel] of affected) {
            if (panel.closing !== promise) continue;
            panel.closing = undefined;
            if (restore && panels.get(tabId) === panel && panel.windowId === undefined) panel.windowId = windowId;
          }
        }
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      },
    };
    closures.set(windowId, closing);
    for (const [, panel] of affected) {
      panel.windowId = undefined;
      panel.closing = promise;
    }
    const timer = setTimeout(
      () => closing.finish(new Error('The companion window did not finish closing within 5000 ms')),
      5000,
    );
    if (callback) {
      try {
        return originalRemove(windowId, () => {
          const error = api.runtime.lastError;
          if (error) closing.finish(new Error(error.message || 'The companion window could not close'), true);
          callback();
        });
      } catch (error) {
        closing.finish(error instanceof Error ? error : new Error(String(error)), true);
        throw error;
      }
    }
    try {
      void originalRemove(windowId).catch(error =>
        closing.finish(error instanceof Error ? error : new Error(String(error)), true),
      );
    } catch (error) {
      closing.finish(error instanceof Error ? error : new Error(String(error)), true);
    }
    return promise;
  };
  Object.defineProperty(remove, '__nbPromise', { value: true });
  api.windows.remove = remove as typeof api.windows.remove;
  const setOptions = async ({ tabId, path, enabled }: chrome.sidePanel.PanelOptions) => {
    if (tabId === undefined) return;
    const current = panels.get(tabId) ?? { path: path ?? 'sidepanel.html' };
    if (path && path !== current.path && current.windowId !== undefined) {
      const previousWindow = current.windowId;
      current.path = path;
      await api.windows.remove(previousWindow).catch(() => undefined);
    }
    if (path) current.path = path;
    if (enabled === false) {
      const removed = current.windowId !== undefined ? api.windows.remove(current.windowId) : current.closing;
      panels.delete(tabId);
      await removed?.catch(() => undefined);
    } else panels.set(tabId, current);
  };
  const open = async ({ tabId }: chrome.sidePanel.OpenOptions) => {
    if (tabId === undefined) throw new Error('The companion window requires a target tab');
    await api.tabs.get(tabId);
    const panel = panels.get(tabId) ?? { path: 'sidepanel.html' };
    panels.set(tabId, panel);
    if (panel.opening) return panel.opening;
    panel.opening = (async () => {
      if (panel.closing) await panel.closing;
      if (panel.windowId !== undefined) {
        const previousWindow = panel.windowId;
        try {
          await api.windows.update(previousWindow, { focused: true });
          if (panel.windowId === previousWindow && !panel.closing) return;
        } catch {
          if (panel.windowId === previousWindow) panel.windowId = undefined;
        }
        if (panel.closing) await panel.closing;
      }
      if (panels.get(tabId) !== panel) throw new Error('The companion window was disabled while opening');
      const window = await api.windows.create({
        url: api.runtime.getURL(`${panel.path}#tab=${tabId}`),
        type: 'popup',
        width: 460,
        height: 780,
        focused: true,
      });
      if (window?.id === undefined) throw new Error('Chrome did not create the companion window');
      if (panels.get(tabId) !== panel) {
        await api.windows.remove(window.id).catch(() => undefined);
        throw new Error('The companion window was disabled while opening');
      }
      panel.windowId = window.id;
    })();
    try {
      await panel.opening;
    } finally {
      panel.opening = undefined;
    }
  };
  (api as unknown as { sidePanel: unknown }).sidePanel = {
    __nbLegacy: true,
    setOptions,
    open,
    setPanelBehavior: async () => {},
  };
  api.tabs.onRemoved.addListener(tabId => {
    void setOptions({ tabId, enabled: false });
  });
  api.windows.onRemoved.addListener(windowId => {
    closures.get(windowId)?.finish();
    panels.forEach(panel => {
      if (panel.windowId === windowId) panel.windowId = undefined;
    });
  });
}
