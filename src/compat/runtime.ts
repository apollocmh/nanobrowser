/** Runtime features missing in Chromium 80. Native implementations always win. */
export function installRuntimeCompatibility(): void {
  const define = (target: object, key: PropertyKey, value: unknown) => {
    if (!(key in target)) Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  define(Array.prototype, 'at', function (this: unknown[], index: number) {
    const n = Math.trunc(Number(index) || 0);
    return this[n < 0 ? this.length + n : n];
  });
  define(String.prototype, 'at', function (this: string, index: number) {
    const n = Math.trunc(Number(index) || 0);
    return this[n < 0 ? this.length + n : n];
  });
  define(
    Array.prototype,
    'findLastIndex',
    function (
      this: unknown[],
      predicate: (value: unknown, index: number, array: unknown[]) => boolean,
      thisArg?: unknown,
    ) {
      for (let i = this.length - 1; i >= 0; i--) if (predicate.call(thisArg, this[i], i, this)) return i;
      return -1;
    },
  );
  define(
    Array.prototype,
    'findLast',
    function (
      this: unknown[],
      predicate: (value: unknown, index: number, array: unknown[]) => boolean,
      thisArg?: unknown,
    ) {
      const index = this.findLastIndex(predicate, thisArg);
      return index < 0 ? undefined : this[index];
    },
  );
  define(Array.prototype, 'toSorted', function (this: unknown[], compare?: (a: unknown, b: unknown) => number) {
    return [...this].sort(compare);
  });
  define(Array.prototype, 'toReversed', function (this: unknown[]) {
    return [...this].reverse();
  });
  define(Object, 'hasOwn', (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key));
  define(
    String.prototype,
    'replaceAll',
    function (this: string, search: string | RegExp, replacement: string | ((...args: unknown[]) => string)) {
      if (search instanceof RegExp) {
        if (!search.global) throw new TypeError('replaceAll requires a global RegExp');
        return this.replace(search, replacement as string);
      }
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return this.replace(new RegExp(escaped, 'g'), replacement as string);
    },
  );
  if (globalThis.crypto)
    define(crypto, 'randomUUID', () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    });
  define(globalThis, 'structuredClone', clone);
  if (typeof TransformStream !== 'undefined') {
    define(
      globalThis,
      'TextDecoderStream',
      class {
        readonly encoding: string;
        readonly fatal: boolean;
        readonly ignoreBOM: boolean;
        readonly readable: ReadableStream<string>;
        readonly writable: WritableStream<BufferSource>;
        constructor(label?: string, options?: TextDecoderOptions) {
          const decoder = new TextDecoder(label, options);
          this.encoding = decoder.encoding;
          this.fatal = decoder.fatal;
          this.ignoreBOM = decoder.ignoreBOM;
          const stream = new TransformStream<BufferSource, string>({
            transform(chunk, controller) {
              const text = decoder.decode(chunk, { stream: true });
              if (text) controller.enqueue(text);
            },
            flush(controller) {
              const text = decoder.decode();
              if (text) controller.enqueue(text);
            },
          });
          this.readable = stream.readable;
          this.writable = stream.writable;
        }
      },
    );
    define(
      globalThis,
      'TextEncoderStream',
      class {
        readonly encoding = 'utf-8';
        readonly readable: ReadableStream<Uint8Array>;
        readonly writable: WritableStream<string>;
        constructor() {
          const encoder = new TextEncoder();
          let pending = '';
          const stream = new TransformStream<string, Uint8Array>({
            transform(chunk, controller) {
              let text = pending + String(chunk);
              pending = '';
              const end = text.charCodeAt(text.length - 1);
              if (end >= 0xd800 && end <= 0xdbff) {
                pending = text.slice(-1);
                text = text.slice(0, -1);
              }
              if (text) controller.enqueue(encoder.encode(text));
            },
            flush(controller) {
              if (pending) controller.enqueue(encoder.encode(pending));
            },
          });
          this.readable = stream.readable;
          this.writable = stream.writable;
        }
      },
    );
  }
  if (typeof ReadableStream !== 'undefined') {
    const values = async function* (this: ReadableStream<unknown>, options?: { preventCancel?: boolean }) {
      const reader = this.getReader();
      let finished = false;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) {
            finished = true;
            return;
          }
          yield next.value;
        }
      } finally {
        try {
          if (!finished && !options?.preventCancel) await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    };
    define(ReadableStream.prototype, 'values', values);
    define(ReadableStream.prototype, Symbol.asyncIterator, values);
  }
  if (typeof AbortSignal !== 'undefined') {
    if (!('reason' in AbortSignal.prototype)) {
      const reasons = new WeakMap<AbortSignal, unknown>();
      const original = AbortController.prototype.abort;
      Object.defineProperty(AbortSignal.prototype, 'reason', {
        get(this: AbortSignal) {
          return reasons.get(this);
        },
      });
      AbortController.prototype.abort = function (reason?: unknown) {
        if (!this.signal.aborted)
          reasons.set(
            this.signal,
            reason === undefined ? new DOMException('The operation was aborted', 'AbortError') : reason,
          );
        original.call(this);
      };
    }
    define(AbortSignal.prototype, 'throwIfAborted', function (this: AbortSignal) {
      if (this.aborted) throw this.reason;
    });
    define(AbortSignal, 'abort', (reason?: unknown) => {
      const c = new AbortController();
      c.abort(reason);
      return c.signal;
    });
    define(AbortSignal, 'timeout', (ms: number) => {
      if (!Number.isInteger(ms) || ms < 0 || ms > Number.MAX_SAFE_INTEGER) throw new RangeError('Invalid timeout');
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('The operation timed out', 'TimeoutError')), ms);
      return c.signal;
    });
    define(AbortSignal, 'any', (signals: AbortSignal[]) => {
      const c = new AbortController();
      const handlers = new Map<AbortSignal, () => void>();
      const finish = (signal: AbortSignal) => {
        c.abort(signal.reason);
        handlers.forEach((handler, s) => s.removeEventListener('abort', handler));
      };
      for (const signal of signals) {
        if (signal.aborted) {
          finish(signal);
          break;
        }
        const handler = () => finish(signal);
        handlers.set(signal, handler);
        signal.addEventListener('abort', handler, { once: true });
      }
      return c.signal;
    });
  }
}

/** Synchronous structured clone for the app's stored and SDK data; reject unsupported objects rather than corrupt them. */
export function clone<T>(value: T, options?: StructuredSerializeOptions): T {
  if (options?.transfer?.length) throw new DOMException('Transfer is not supported by this browser', 'DataCloneError');
  const seen = new Map<object, unknown>();
  const visit = (input: unknown): unknown => {
    if (typeof input === 'function' || typeof input === 'symbol')
      throw new DOMException('Value cannot be cloned', 'DataCloneError');
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) return seen.get(input);
    if (input instanceof Date) {
      const out = new Date(input);
      seen.set(input, out);
      return out;
    }
    if (input instanceof RegExp) {
      const out = new RegExp(input.source, input.flags);
      seen.set(input, out);
      return out;
    }
    if (input instanceof ArrayBuffer) {
      const out = input.slice(0);
      seen.set(input, out);
      return out;
    }
    if (ArrayBuffer.isView(input)) {
      const buffer = visit(input.buffer) as ArrayBuffer;
      return input instanceof DataView
        ? new DataView(buffer, input.byteOffset, input.byteLength)
        : new (input.constructor as new (buffer: ArrayBuffer, offset: number, length: number) => unknown)(
            buffer,
            input.byteOffset,
            (input as unknown as { length: number }).length,
          );
    }
    if (input instanceof Blob) return input.slice(0, input.size, input.type);
    if (input instanceof Map) {
      const out = new Map();
      seen.set(input, out);
      input.forEach((v, k) => out.set(visit(k), visit(v)));
      return out;
    }
    if (input instanceof Set) {
      const out = new Set();
      seen.set(input, out);
      input.forEach(v => out.add(visit(v)));
      return out;
    }
    if (
      !Array.isArray(input) &&
      Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null
    )
      throw new DOMException('Object type cannot be cloned', 'DataCloneError');
    const out: Record<string, unknown> | unknown[] = Array.isArray(input) ? new Array(input.length) : {};
    seen.set(input, out);
    for (const key of Object.keys(input))
      Object.defineProperty(out, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: visit((input as Record<string, unknown>)[key]),
      });
    return out;
  };
  return visit(value) as T;
}
