import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyCdpChannel } from '../legacy-cdp';

type Event = (source: chrome.debugger.Debuggee, method: string, params?: object) => void;
type Detach = (source: chrome.debugger.Debuggee) => void;
const channels: LegacyCdpChannel[] = [];

function setup(tabId = 7) {
  const events = new Set<Event>();
  const detachments = new Set<Detach>();
  const sendCommand = vi.fn(async (_target: object, _method: string, _params: object) => ({}));
  vi.stubGlobal('chrome', {
    debugger: {
      sendCommand,
      onEvent: { addListener: (fn: Event) => events.add(fn), removeListener: (fn: Event) => events.delete(fn) },
      onDetach: {
        addListener: (fn: Detach) => detachments.add(fn),
        removeListener: (fn: Detach) => detachments.delete(fn),
      },
    },
  });
  const channel = new LegacyCdpChannel(tabId);
  channels.push(channel);
  const emit = (method: string, params: object, tab = tabId) => {
    for (const fn of events) fn({ tabId: tab }, method, params);
  };
  const reply = (sessionId: string, message: object) =>
    emit('Target.receivedMessageFromTarget', { sessionId, message: JSON.stringify(message) });
  return { channel, events, detachments, sendCommand, emit, reply };
}

afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LegacyCdpChannel', () => {
  it('invalidates pending descendant sessions immediately when a parent detaches', async () => {
    vi.useFakeTimers();
    const { channel, emit, reply } = setup();
    emit('Target.attachedToTarget', { sessionId: 'parent' });
    reply('parent', { method: 'Target.attachedToTarget', params: { sessionId: 'child' } });
    const response = channel.send('child', 'Runtime.evaluate', {}, 1000);
    const rejected = expect(response).rejects.toThrow('Child session detached');
    emit('Target.detachedFromTarget', { sessionId: 'parent' });
    await rejected;
    await expect(channel.send('child', 'Runtime.evaluate')).rejects.toThrow('detached or unknown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never sends a new root command through a closed channel', async () => {
    const { channel, sendCommand } = setup();
    channel.close();
    await expect(channel.send(undefined, 'Input.dispatchMouseEvent')).rejects.toThrow('channel is closed');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it.each(['not json', 'null'])(
    'rejects malformed child payload %s without throwing from the event listener',
    async message => {
      const { channel, emit } = setup();
      emit('Target.attachedToTarget', { sessionId: 'frame' });
      const response = channel.send('frame', 'Runtime.evaluate');
      const rejected = expect(response).rejects.toThrow('Invalid child protocol response');
      expect(() => emit('Target.receivedMessageFromTarget', { sessionId: 'frame', message })).not.toThrow();
      await rejected;
    },
  );

  it('does not resolve a response belonging to a sibling session with the same command id', async () => {
    const { channel, emit, reply, sendCommand } = setup();
    emit('Target.attachedToTarget', { sessionId: 'a' });
    emit('Target.attachedToTarget', { sessionId: 'b' });
    const response = channel.send('a', 'Runtime.evaluate');
    const packet = JSON.parse((sendCommand.mock.calls[0][2] as { message: string }).message);
    reply('b', { id: packet.id, result: { value: 'wrong session' } });
    reply('a', { id: packet.id, result: { value: 'correct session' } });
    await expect(response).resolves.toEqual({ value: 'correct session' });
  });

  it('routes a nested frame command through both non-flat session envelopes', async () => {
    const { channel, emit, reply, sendCommand } = setup();
    emit('Target.attachedToTarget', { sessionId: 'parent' });
    reply('parent', { method: 'Target.attachedToTarget', params: { sessionId: 'child' } });
    const response = channel.send('child', 'DOM.getBoxModel', { backendNodeId: 45 }, 1000);
    const [target, method, params] = sendCommand.mock.calls[0];
    expect(target).toEqual({ tabId: 7 });
    expect(method).toBe('Target.sendMessageToTarget');
    const outer = params as { sessionId: string; message: string };
    expect(outer.sessionId).toBe('parent');
    const middle = JSON.parse(outer.message);
    expect(middle.method).toBe('Target.sendMessageToTarget');
    expect(middle.params.sessionId).toBe('child');
    const inner = JSON.parse(middle.params.message);
    expect(inner).toMatchObject({ method: 'DOM.getBoxModel', params: { backendNodeId: 45 } });
    reply('parent', { id: middle.id, result: {} });
    reply('parent', {
      method: 'Target.receivedMessageFromTarget',
      params: {
        sessionId: 'child',
        message: JSON.stringify({ id: inner.id, result: { model: { width: 120 } } }),
      },
    });
    await expect(response).resolves.toEqual({ model: { width: 120 } });
  });

  it('preserves session IDs for events and ignores events from a different tab', () => {
    const { channel, emit, reply } = setup();
    const listener = vi.fn();
    const unsubscribe = channel.on(listener);
    emit('Page.frameNavigated', { frame: { id: 'other' } }, 8);
    reply('frame-session', { method: 'Page.frameNavigated', params: { frame: { id: 'frame' } } });
    expect(listener).toHaveBeenCalledExactlyOnceWith('frame-session', 'Page.frameNavigated', {
      frame: { id: 'frame' },
    });
    unsubscribe();
    emit('Page.frameStoppedLoading', { frameId: 'frame' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('adapts only the known old protocol parameter spellings without mutating callers', async () => {
    const { channel, sendCommand } = setup();
    const args = { flatten: true, autoAttach: true, waitForDebuggerOnStart: false, filter: [{ type: 'iframe' }] };
    await channel.send(undefined, 'Target.setAutoAttach', args);
    expect(sendCommand.mock.calls[0][2]).toEqual({ flatten: false, autoAttach: true, waitForDebuggerOnStart: false });
    expect(args.flatten).toBe(true);
    expect(args.filter).toHaveLength(1);
    await channel.send(undefined, 'Page.createIsolatedWorld', { frameId: 'frame', grantUniversalAccess: true });
    expect(sendCommand.mock.calls[1][2]).toEqual({ frameId: 'frame', grantUniveralAccess: true });
  });

  it('rejects unknown child sessions before sending any input', async () => {
    const { channel, sendCommand } = setup();
    await expect(channel.send('missing', 'Input.dispatchMouseEvent', { type: 'mousePressed' })).rejects.toThrow(
      'detached or unknown',
    );
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('expires a child response budget and ignores its late response', async () => {
    vi.useFakeTimers();
    const { channel, emit, reply, sendCommand } = setup();
    emit('Target.attachedToTarget', { sessionId: 'frame' });
    const result = channel.send('frame', 'Runtime.evaluate', {}, 25);
    const rejected = expect(result).rejects.toThrow('timed out after 25 ms');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    const packet = JSON.parse((sendCommand.mock.calls[0][2] as { message: string }).message);
    expect(() => reply('frame', { id: packet.id, result: { value: 'late' } })).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects all pending nested commands and unregisters its listeners on close', async () => {
    vi.useFakeTimers();
    const { channel, emit, reply, events, detachments } = setup();
    emit('Target.attachedToTarget', { sessionId: 'parent' });
    reply('parent', { method: 'Target.attachedToTarget', params: { sessionId: 'child' } });
    const result = channel.send('child', 'Runtime.evaluate', {}, 1000);
    const rejected = expect(result).rejects.toThrow('Debugger detached');
    channel.close();
    await rejected;
    expect(events.size).toBe(0);
    expect(detachments.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates child protocol errors rather than returning an empty result', async () => {
    const { channel, emit, reply, sendCommand } = setup();
    emit('Target.attachedToTarget', { sessionId: 'frame' });
    const result = channel.send('frame', 'DOM.getBoxModel');
    const packet = JSON.parse((sendCommand.mock.calls[0][2] as { message: string }).message);
    reply('frame', { id: packet.id, error: { code: -32000, message: 'Node is detached' } });
    await expect(result).rejects.toThrow('Node is detached');
  });
});
