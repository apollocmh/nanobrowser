// Raw CDP commands through chrome.debugger, sent to the session of a frame that Puppeteer reports.
// Elements are never reached through Puppeteer; every element command goes through here.
import { LayerError } from '../protocol/errors';
import { browserMajor, legacyChannel } from './legacy-cdp';
import { legacyMousePosition, legacyScreenshotClip, normalizeLayoutMetrics } from './layout-metrics';
import type { LegacyMetrics } from './layout-metrics';
import { aroundScreenshot, dispatchInputEvent } from './input-observer';

/** The pseudo session ID ExtensionTransport gives the page target. chrome.debugger addresses it with no sessionId. */
export const PAGE_SESSION_ALIAS = 'pageTargetSessionId';

/** Session ID as the layer uses it: undefined for the tab's root session. */
export function normalizeSessionId(sessionId: string | undefined): string | undefined {
  return sessionId === PAGE_SESSION_ALIAS ? undefined : sessionId;
}

/** @deprecated name kept for the step 0.2 spike; use normalizeSessionId. */
export const toDebuggerSessionId = normalizeSessionId;

export class CdpCommandError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'CdpCommandError';
  }
}

/** A command that did not answer in time. It cannot be cancelled, so its outcome is unknown. */
export class CdpTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method}: no answer within ${timeoutMs} ms`);
    this.name = 'CdpTimeoutError';
  }
}

/** Timeouts: 10 s for captures, 5 s otherwise. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
export const CAPTURE_TIMEOUT_MS = 10_000;

/** Sends one command. `cancel`, when it settles first, rejects the command (used for detach). */
export async function sendRaw<T = unknown>(
  tabId: number,
  sessionId: string | undefined,
  method: string,
  params: object = {},
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  cancel?: Promise<never>,
): Promise<T> {
  const target: chrome.debugger.DebuggerSession = { tabId };
  const debuggerSessionId = normalizeSessionId(sessionId);
  if (debuggerSessionId) target.sessionId = debuggerSessionId;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupted = false;
  let interruption: unknown;
  let captureStarted = false;
  let command: Promise<unknown> | undefined;
  const input =
    method === 'Input.dispatchMouseEvent'
      ? dispatchInputEvent({ tabId, method, params: params as Record<string, unknown>, phase: 'pending' })
      : undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      interrupted = true;
      interruption = new CdpTimeoutError(method, timeoutMs);
      reject(interruption);
    }, timeoutMs);
  });
  const cancelled = cancel?.catch(error => {
    interrupted = true;
    interruption = error;
    throw error;
  });
  // A screenshot can still be in its bounded hide stage when either promise rejects.
  void timeout.catch(() => undefined);
  void cancelled?.catch(() => undefined);
  const race = <V>(pending: Promise<V>) => Promise.race(cancelled ? [pending, timeout, cancelled] : [pending, timeout]);
  try {
    const send = async () => {
      // A late hide must restore itself without dispatching after the caller has already stopped or timed out.
      if (interrupted) return Promise.reject(interruption);
      // Once the capture callback starts, even preparation reads race the command budget and restore decorations.
      captureStarted = true;
      let dispatchParams = params;
      if (method === 'Input.dispatchMouseEvent' && browserMajor() < 102) {
        const metrics = await race(
          legacyChannel(tabId).send(debuggerSessionId, 'Page.getLayoutMetrics', {}, timeoutMs),
        );
        dispatchParams = legacyMousePosition(params, metrics as LegacyMetrics);
        // Stop or timeout while reading zoom must not turn into a late input dispatch.
        if (interrupted) throw interruption;
      }
      if (method === 'Page.captureScreenshot' && browserMajor() < 90 && (params as { clip?: unknown }).clip) {
        const metrics = await race(
          legacyChannel(tabId).send(debuggerSessionId, 'Page.getLayoutMetrics', {}, timeoutMs),
        );
        dispatchParams = legacyScreenshotClip(params, metrics as LegacyMetrics);
        if (interrupted) throw interruption;
      }
      const raw =
        browserMajor() < 125
          ? legacyChannel(tabId).send(debuggerSessionId, method, dispatchParams, timeoutMs)
          : chrome.debugger.sendCommand(target, method, dispatchParams as Record<string, unknown>);
      return race(
        raw.catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (/not attached|Detached while handling command|No tab with given id/i.test(message)) {
            throw new LayerError('DEBUGGER_DETACHED', `${method}: ${message}`, { delivered: 'unknown' });
          }
          throw new CdpCommandError(method, message);
        }),
      );
    };
    command = method === 'Page.captureScreenshot' ? aroundScreenshot(tabId, send) : send();
    const result = await race(command);
    if (input) dispatchInputEvent({ ...input, phase: 'confirmed' });
    return (method === 'Page.getLayoutMetrics' ? normalizeLayoutMetrics(result as LegacyMetrics) : result) as T;
  } catch (error) {
    // Race inside the capture callback too, so unresolved Chrome commands still run decoration cleanup.
    if (method === 'Page.captureScreenshot' && captureStarted) await command?.catch(() => undefined);
    if (input)
      dispatchInputEvent({
        ...input,
        phase: error instanceof CdpTimeoutError || error instanceof LayerError ? 'unknown' : 'failed',
      });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
