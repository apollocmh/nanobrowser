// MV2 uses the same product panel and approval path in real per-tab popup windows.
import { FIXTURE_ORIGIN } from '../fixtures-config';
import { attach } from '../spike-session';
import { defineCheck } from './registry';
import { assert, evaluate, sleep, waitForLoad } from './helpers';
import { panel, scriptReplies, seedFixtureModel, waitForText } from './panel-chat';

defineCheck({
  name: 'companion-window',
  title: 'MV2 companion window lifecycle and approval',
  description: 'Real popup creation, reuse, per-tab binding, approval isolation, reopen and target-tab close.',
  async run() {
    assert(chrome.runtime.getManifest().manifest_version === 2, 'this check requires the MV2 companion build');
    await seedFixtureModel();
    const first = await chrome.tabs.create({ url: `${FIXTURE_ORIGIN}/g-writes.html`, active: true });
    const second = await chrome.tabs.create({ url: `${FIXTURE_ORIGIN}/c-text.html`, active: false });
    const windows: number[] = [];
    const views = async (tabId: number) =>
      (await chrome.tabs.query({})).filter(tab => tab.url === chrome.runtime.getURL(`sidepanel.html#tab=${tabId}`));
    const open = async (tabId: number) => {
      await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
      await chrome.sidePanel.open({ tabId });
      await sleep(600);
      const found = await views(tabId);
      assert(
        found.length === 1,
        `tab ${tabId} owns exactly one companion window; found ${JSON.stringify(found.map(tab => ({ id: tab.id, windowId: tab.windowId, url: tab.url })))}`,
      );
      windows.push(found[0].windowId);
      return found[0];
    };
    try {
      await Promise.all([waitForLoad(first.id!), waitForLoad(second.id!)]);
      const one = await open(first.id!);
      const repeated = await open(first.id!);
      assert(one.id === repeated.id && one.windowId === repeated.windowId, 'repeated open focuses the same window');
      const two = await open(second.id!);
      assert(two.windowId !== one.windowId, 'different target tabs have different windows');
      assert((await chrome.windows.get(one.windowId)).type === 'popup', 'the companion is a real popup window');
      await scriptReplies([
        {
          toolCalls: [
            { name: 'click', input: { target: { role: 'button', name: 'Send' }, intent: 'Send the reply to Dana' } },
          ],
        },
        { toolCalls: [{ name: 'snapshot', input: {} }] },
        { toolCalls: [{ name: 'done', input: { outcome: 'success', summary: 'Companion approval completed.' } }] },
      ]);
      await panel(first.id!, 'type-send', { text: 'Send the reply' });
      let body = '';
      for (let i = 0; i < 60 && !body.includes('Send this?'); i++) {
        await sleep(150);
        body = (await panel(first.id!, 'read')).body;
      }
      assert(body.includes('Send this?'), `the write approval appears in the bound popup: ${body.slice(-2500)}`);
      assert(!(await panel(second.id!, 'read')).body.includes('Send this?'), 'approval is not sent to the other popup');
      await attach(first.id!);
      assert((await evaluate(first.id!, undefined, 'window.hits.length')) === 0, 'no write occurs before approval');
      await chrome.windows.update(one.windowId, { focused: true });
      const image = await chrome.tabs.captureVisibleTab(one.windowId, { format: 'png' });
      await panel(first.id!, 'click', { label: 'Allow' });
      await waitForText(first.id!, 'Companion approval completed.');
      assert((await evaluate(first.id!, undefined, 'window.hits.join(",")')) === 'send', 'approval sends exactly once');
      await chrome.windows.remove(one.windowId);
      const reopened = await open(first.id!);
      assert(reopened.id !== one.id, 'closing and reopening creates a new panel document');
      await waitForText(first.id!, 'Companion approval completed.');
      await chrome.tabs.remove(first.id!);
      for (let i = 0; i < 30 && (await chrome.windows.get(reopened.windowId).catch(() => null)); i++) await sleep(100);
      assert(
        (await chrome.windows.get(reopened.windowId).catch(() => null)) === null,
        'closing the target closes its popup',
      );
      assert((await views(second.id!)).length === 1, 'the other target keeps its popup');
      return {
        userAgent: navigator.userAgent,
        reused: true,
        isolated: true,
        approvedOnce: true,
        restoredConversation: true,
        closedWithTarget: true,
        image,
      };
    } finally {
      for (const id of new Set(windows)) await chrome.windows.remove(id).catch(() => undefined);
      for (const id of [first.id!, second.id!]) await chrome.tabs.remove(id).catch(() => undefined);
    }
  },
});
