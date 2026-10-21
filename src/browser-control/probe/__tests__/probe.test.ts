import { describe, expect, it } from 'vitest';
import { PROBE_SOURCE } from '../index';

describe('probe string', () => {
  it('recognizes native-draggable ancestors, including the browser default for links and images', () => {
    const scope = {} as Record<string, unknown>;
    new Function('globalThis', PROBE_SOURCE)(scope);
    const probe = scope.__nbProbe as { dragInfo(el: unknown): { native: boolean } };
    const image = { draggable: true, parentElement: null };
    expect(probe.dragInfo(image)).toEqual({ native: true });
    expect(probe.dragInfo({ draggable: false, parentElement: image })).toEqual({ native: true });
    expect(probe.dragInfo({ draggable: false, parentElement: null })).toEqual({ native: false });
  });

  it('blocks a late native dragstart before an old browser can enter its OS drag loop', () => {
    const scope = {} as Record<string, unknown>;
    let handler: ((event: unknown) => void) | undefined;
    const window = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === 'dragstart') handler = listener;
      },
      removeEventListener: () => {
        handler = undefined;
      },
    };
    new Function('globalThis', 'window', PROBE_SOURCE)(scope, window);
    const probe = scope.__nbProbe as {
      armNativeDragBlock(ms: number): void;
      disarmNativeDragGuard(): void;
      readGuard(): { verdict: string };
    };
    let prevented = false;
    let stopped = false;
    probe.armNativeDragBlock(1000);
    handler!({
      type: 'dragstart',
      isTrusted: true,
      preventDefault: () => {
        prevented = true;
      },
      stopImmediatePropagation: () => {
        stopped = true;
      },
    });
    expect(prevented && stopped).toBe(true);
    expect(probe.readGuard().verdict).toBe('cancelled');
    probe.disarmNativeDragGuard();
    expect(handler).toBeUndefined();
  });

  it('does not turn decoration changes into page activity, or omit content carrying a decoration marker', () => {
    const scope = {} as Record<string, unknown>;
    let changed!: (records: unknown[]) => void;
    class Element {
      tagName = 'DIV';
      childNodes: unknown[] = [];
      style = { pointerEvents: 'none' };
      getAttribute(name: string) {
        return name === 'aria-hidden' ? 'true' : null;
      }
      hasAttribute(name: string) {
        return name === 'data-nanobrowser-cursor';
      }
    }
    class Observer {
      constructor(callback: (records: unknown[]) => void) {
        changed = callback;
      }
      observe() {}
    }
    const document = { documentElement: {} };
    new Function('globalThis', 'MutationObserver', 'document', 'HTMLElement', PROBE_SOURCE)(
      scope,
      Observer,
      document,
      Element,
    );
    const cursor = new Element();
    const probe = scope.__nbProbe as { mutations(): number };
    changed([
      { type: 'attributes', target: cursor },
      { type: 'childList', target: document.documentElement, addedNodes: [cursor], removedNodes: [] },
    ]);
    expect(probe.mutations()).toBe(0);
    const pageContent = new Element();
    pageContent.childNodes.push({ textContent: 'Real page data' });
    changed([
      { type: 'attributes', target: pageContent },
      { type: 'childList', target: document.documentElement, addedNodes: [cursor, pageContent], removedNodes: [] },
    ]);
    expect(probe.mutations()).toBe(2);
  });

  it('is self-contained: it runs with nothing from the module in scope', () => {
    const scope = {} as Record<string, unknown>;
    // Evaluate with a fresh global object, as the isolated world would; no DOM APIs are needed to install.
    new Function('globalThis', PROBE_SOURCE)(scope);
    const probe = scope.__nbProbe as { version: number; mutations(): number };
    expect(probe.version).toBe(1);
    expect(probe.mutations()).toBe(0);
  });

  it('installs once and cannot be replaced by later scripts in the same world', () => {
    const scope = {} as Record<string, unknown>;
    new Function('globalThis', PROBE_SOURCE)(scope);
    const first = scope.__nbProbe;
    new Function('globalThis', PROBE_SOURCE)(scope);
    expect(scope.__nbProbe).toBe(first);
    expect(() => {
      'use strict';
      (scope as { __nbProbe: unknown }).__nbProbe = 1;
    }).toThrow();
  });
});

describe('approximateName, the classifier’s fallback name', () => {
  const scope = {} as Record<string, unknown>;
  new Function('globalThis', PROBE_SOURCE)(scope);
  const probe = scope.__nbProbe as { approximateName(el: unknown): string };
  /** An element as approximateName reads it: tag, type, value, rendered text and attributes; no labels. */
  const element = (tagName: string, props: Record<string, unknown>, attrs: Record<string, string> = {}) => ({
    tagName,
    innerText: '',
    labels: [],
    getAttribute: (name: string) => attrs[name] ?? null,
    ...props,
  });

  it('never names a control that holds a value by what it holds', () => {
    expect(probe.approximateName(element('INPUT', { type: 'password', value: 'hunter2' }))).toBe('');
    expect(probe.approximateName(element('INPUT', { type: 'text', value: '4111111111111111' }))).toBe('');
    expect(probe.approximateName(element('SELECT', { innerText: '4111 1111 1111 1111', value: 'c1' }))).toBe('');
    expect(probe.approximateName(element('TEXTAREA', { innerText: '654321', value: '654321' }))).toBe('');
    expect(
      probe.approximateName(element('INPUT', { type: 'password', value: 'hunter2' }, { 'aria-label': 'Password' })),
    ).toBe('Password');
  });

  it('still names buttons by their text or caption', () => {
    expect(probe.approximateName(element('INPUT', { type: 'submit', value: 'Pay now' }))).toBe('Pay now');
    expect(probe.approximateName(element('BUTTON', { innerText: 'Delete', value: '' }))).toBe('Delete');
  });
});
