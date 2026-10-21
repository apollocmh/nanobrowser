// Inspect extension pages through the extension's own debugger, including startup exceptions before React renders.
import { defineCheck } from './registry';
import { assert, sleep, waitForLoad } from './helpers';

defineCheck({
  name: 'ui-compatibility',
  title: 'Extension page startup diagnostics',
  description: 'Records real document text and startup exceptions for the settings and welcome pages.',
  async run() {
    const results = [];
    for (const path of ['options.html#general', 'welcome.html']) {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      const errors: unknown[] = [];
      const listener = (source: chrome.debugger.DebuggerSession, method: string, params?: object) => {
        if (source.tabId === tab.id && (method === 'Runtime.exceptionThrown' || method === 'Log.entryAdded'))
          errors.push({ method, params });
      };
      try {
        await chrome.debugger.attach({ tabId: tab.id! }, '1.3');
        chrome.debugger.onEvent.addListener(listener);
        await chrome.debugger.sendCommand({ tabId: tab.id! }, 'Runtime.enable');
        await chrome.debugger.sendCommand({ tabId: tab.id! }, 'Log.enable');
        await chrome.tabs.update(tab.id!, { url: chrome.runtime.getURL(path) });
        await waitForLoad(tab.id!);
        await sleep(700);
        const state = await chrome.debugger.sendCommand({ tabId: tab.id! }, 'Runtime.evaluate', {
          expression:
            '({text:document.body.innerText,html:document.getElementById("app-container").innerHTML.slice(0,500)})',
          returnByValue: true,
        });
        results.push({ path, state, errors });
        assert(
          Boolean((state as { result?: { value?: { text?: string } } }).result?.value?.text),
          `${path} renders content; ${JSON.stringify(errors)}`,
        );
        assert(
          !errors.some(error => (error as { method: string }).method === 'Runtime.exceptionThrown'),
          `${path} has no startup exception: ${JSON.stringify(errors)}`,
        );
      } finally {
        chrome.debugger.onEvent.removeListener(listener);
        await chrome.debugger.detach({ tabId: tab.id! }).catch(() => undefined);
        await chrome.tabs.remove(tab.id!).catch(() => undefined);
      }
    }
    return { userAgent: navigator.userAgent, results };
  },
});
