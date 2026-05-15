// Core WebSocket client (MYR-50).
//
// Implements state-machine.md §1 (connectionState C-1..C-12) and
// websocket-protocol.md §2 (handshake + auth frame), §2.3 rule 4
// (pre-`auth_ok` 6 s timer), §7.1 (reconnect backoff), §7.4.1
// (post-`auth_ok` liveness watchdog). Web-only (browser WebSocket /
// Node `ws`) per NFR-3.33 — Apple platforms use the Swift SDK.
//
// Timers here are TRANSPORT timers (backoff / pre-auth / watchdog) and
// are explicitly allowed — the NFR-3.7 "no client-side timers" rule is
// about data *freshness* (the reconciler), not connection liveness.

import { RedactingLogger } from '../observability/redacting-logger.js';
import { ConsoleLogger } from '../observability/logger.js';
import type { Logger } from '../observability/logger.js';
import type { MetricsRecorder } from '../observability/metrics.js';
import { Metric } from '../observability/metrics.js';
import { wsErrorToCoreError } from '../errors/core-error.js';
import type { CoreError } from '../errors/core-error.js';
import { computeBackoffMs } from './backoff.js';
import type {
  ClientEvent,
  ClientListener,
  ConnectionState,
  MyRoboTaxiClientOptions,
  WebSocketFactory,
  WebSocketLike,
} from './types.js';

const DEFAULT_HEARTBEAT_MS = 15_000;
const PRE_AUTH_OK_TIMEOUT_MS = 6_000; // §2.3 rule 4 (1 s grace over server 5 s)
const WS_OPEN = 1;

const NOOP_METRICS: MetricsRecorder = {
  counter() {
    /* no-op */
  },
  histogram() {
    /* no-op */
  },
  gauge() {
    /* no-op */
  },
};

export class MyRoboTaxiClient {
  private state: ConnectionState = 'initializing';
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private destroyed = false;

  private preAuthTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly listeners = new Set<ClientListener>();
  private readonly logger: Logger;
  private readonly metrics: MetricsRecorder;
  private readonly url: string;
  private readonly getToken: () => Promise<string>;
  private readonly heartbeatMs: number;
  private readonly watchdogMs: number;
  private readonly maxRetries: number;
  private readonly wsFactory: WebSocketFactory;

  constructor(opts: MyRoboTaxiClientOptions) {
    // Auto-wrap so a raw consumer logger can never see the P1 token /
    // auth_ok userId (FR-11.2).
    this.logger = new RedactingLogger(opts.logger ?? new ConsoleLogger());
    this.metrics = opts.metrics ?? NOOP_METRICS;
    this.url = opts.url;
    this.getToken = opts.getToken;
    this.heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.watchdogMs = this.heartbeatMs * 2; // §7.4.1
    this.maxRetries = opts.maxRetries ?? Number.POSITIVE_INFINITY;
    const factory =
      opts.webSocketFactory ??
      ((u: string) => {
        const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike })
          .WebSocket;
        if (!Ctor) {
          throw new Error(
            'No WebSocket implementation: pass `webSocketFactory` (Node consumers wire the `ws` package).',
          );
        }
        return new Ctor(u);
      });
    this.wsFactory = factory;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  subscribe(listener: ClientListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** C-1: initializing → connecting. Idempotent while already active. */
  connect(): void {
    if (this.destroyed) return;
    if (this.state === 'connecting' || this.state === 'connected') return;
    this.openSocket();
  }

  /** C-10: USER_STOPPED → error. Cancels reconnect; idempotent. */
  disconnect(): void {
    if (this.destroyed) return;
    this.clearTimers();
    this.closeSocket(1000, 'client disconnect');
    this.transition('error', 'user_stopped');
  }

  /** C-11: USER_RETRY (from error) → connecting. Resets the retry counter. */
  retry(): void {
    if (this.destroyed) return;
    if (this.state !== 'error') return;
    this.attempt = 0;
    this.openSocket();
  }

  /** C-12: terminal. Releases all resources. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();
    this.closeSocket(1000, 'client destroyed');
    this.listeners.clear();
  }

  // ---- internals ---------------------------------------------------------

  private openSocket(): void {
    this.transition('connecting');
    this.attempt += 1;
    const outcomeTag = (outcome: string): { outcome: string } => ({ outcome });

    void this.getToken()
      .then((token) => {
        if (this.destroyed || this.state !== 'connecting') return;
        let socket: WebSocketLike;
        try {
          socket = this.wsFactory(this.url);
        } catch (err) {
          this.metrics.counter(Metric.WS_CONNECT_ATTEMPTS, outcomeTag('fail'));
          this.logger.error('ws: factory threw', {
            err: err instanceof Error ? err.message : String(err),
          });
          this.scheduleReconnect('ws_open_failed');
          return;
        }
        this.ws = socket;

        socket.onopen = () => {
          // §2.2: auth frame MUST be the first frame. Token is P1 — never
          // logged (not passed in any log meta).
          socket.send(JSON.stringify({ type: 'auth', payload: { token } }));
          // §2.3 rule 4: bound the wait for auth_ok.
          this.armPreAuthTimer();
        };
        socket.onmessage = (ev) => this.onMessage(ev.data);
        socket.onclose = (ev) => this.onClose(ev.code);
        socket.onerror = () => this.onError();
      })
      .catch((err: unknown) => {
        this.metrics.counter(Metric.WS_CONNECT_ATTEMPTS, outcomeTag('fail'));
        this.logger.error('ws: getToken rejected', {
          err: err instanceof Error ? err.message : String(err),
        });
        // C-2-ish: token unavailable. Treat as a failed attempt → backoff.
        this.scheduleReconnect('init_failed');
      });
  }

  private onMessage(raw: unknown): void {
    this.resetWatchdog(); // any frame is a liveness signal (§7.4.1)
    let msg: { type?: string; payload?: unknown };
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as typeof msg;
    } catch {
      this.logger.warn('ws: unparseable frame');
      return;
    }
    const type = msg.type ?? '';

    if (type === 'auth_ok') {
      this.cancelPreAuthTimer();
      this.attempt = 0; // C-3: reset retry counter
      this.metrics.counter(Metric.WS_CONNECT_ATTEMPTS, { outcome: 'success' });
      this.transition('connected');
      this.armWatchdog();
      return;
    }

    if (type === 'error') {
      const core = wsErrorToCoreError(
        (msg.payload ?? { code: 'internal_error', message: 'error' }) as never,
      );
      this.emitError(core);
      this.metrics.counter(Metric.AUTH_FAILED, {
        subCode: core.code === 'auth_failed' && 'subCode' in core && core.subCode
          ? core.subCode
          : 'null',
      });
      if (core.terminal) {
        // C-8: auth rejected (or other terminal) → error, close.
        this.clearTimers();
        this.closeSocket(1008, core.code);
        this.transition('error', core.code);
      } else {
        // auth_timeout / rate_limited / transient → C-4 reconnect.
        this.closeSocket(1001, core.code);
        this.scheduleReconnect(core.code);
      }
      return;
    }

    if (type === 'heartbeat') {
      // Liveness only (already reset above). NFR-3.7: never a freshness signal.
      return;
    }

    // Data frame. Latency metric if the payload carries a server timestamp.
    this.metrics.counter(Metric.WS_MESSAGE_RECEIVED, { type });
    const ts = (msg.payload as { timestamp?: string } | undefined)?.timestamp;
    if (ts) {
      const sentMs = Date.parse(ts);
      if (!Number.isNaN(sentMs)) {
        this.metrics.histogram(Metric.WS_MESSAGE_LATENCY_MS, Date.now() - sentMs, { type });
      }
    }
    this.emit({ kind: 'frame', type, payload: msg.payload });
  }

  private onClose(code?: number): void {
    if (this.destroyed) return;
    if (this.state === 'connecting') {
      this.scheduleReconnect(`ws_closed_${code ?? 'unknown'}`); // C-4
      return;
    }
    if (this.state === 'connected') {
      this.scheduleReconnect(`ws_closed_${code ?? 'unknown'}`); // C-6
    }
  }

  private onError(): void {
    if (this.destroyed) return;
    if (this.state === 'connecting' || this.state === 'connected') {
      this.scheduleReconnect('ws_error'); // C-7 / C-4
    }
  }

  private scheduleReconnect(reason: string): void {
    this.clearTimers();
    this.closeSocket(1001, reason);
    if (this.attempt >= this.maxRetries) {
      this.transition('error', 'max_retries_exhausted'); // C-5
      return;
    }
    this.transition('disconnected', reason); // C-4 / C-6 / C-7
    const delay = computeBackoffMs(this.attempt);
    this.metrics.counter(Metric.WS_RECONNECT);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
      this.openSocket(); // C-9: RECONNECT_TIMER_FIRED
    }, delay);
  }

  private armPreAuthTimer(): void {
    this.cancelPreAuthTimer();
    this.preAuthTimer = setTimeout(() => {
      this.preAuthTimer = null;
      if (this.destroyed || this.state !== 'connecting') return;
      // §2.3 rule 4: silent handshake failure → close 1001, auth_timeout,
      // reconnect with backoff.
      this.logger.warn('ws: auth_ok not received within pre-auth window');
      this.scheduleReconnect('auth_timeout');
    }, PRE_AUTH_OK_TIMEOUT_MS);
  }

  private cancelPreAuthTimer(): void {
    if (this.preAuthTimer) {
      clearTimeout(this.preAuthTimer);
      this.preAuthTimer = null;
    }
  }

  private armWatchdog(): void {
    this.resetWatchdog();
  }

  private resetWatchdog(): void {
    if (this.state !== 'connected' && this.watchdogTimer === null) return;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.destroyed || this.state !== 'connected') return;
      // §7.4.1: no frame for 2× heartbeat → silent disconnect → C-6.
      this.logger.warn('ws: liveness watchdog fired (silent disconnect)');
      this.scheduleReconnect('heartbeat_timeout');
    }, this.watchdogMs);
  }

  private clearTimers(): void {
    this.cancelPreAuthTimer();
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(code: number, reason: string): void {
    if (!this.ws) return;
    const sock = this.ws;
    this.ws = null;
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
    try {
      if (sock.readyState === WS_OPEN) sock.close(code, reason);
      else sock.close();
    } catch {
      /* socket already closing/closed — ignore */
    }
  }

  private transition(to: ConnectionState, reason?: string): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.emit({ kind: 'connectionState', from, to, reason });
  }

  private emitError(error: CoreError): void {
    this.emit({ kind: 'error', error });
  }

  private emit(event: ClientEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.logger.error('ws: listener threw', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
