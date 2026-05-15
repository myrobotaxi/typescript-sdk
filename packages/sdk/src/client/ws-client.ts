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
  Subscription,
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

  // ---- per-vehicle subscription (MYR-83) ---------------------------------
  // DV-07 (websocket-protocol.md §10): the server does NOT process
  // subscribe/unsubscribe yet — it implicitly fans out every owned
  // vehicle from the auth handshake (MYR-46). So this surface is two
  // things: (1) a forward-compatible wire intent — frames the server
  // will honour once DV-07 lands, harmless no-ops until then; and
  // (2) the part with teeth TODAY — a client-side defensive drop of
  // vehicle-scoped frames outside the subscribed set, once selective
  // mode is on. We deliberately do NOT attribute a permission_denied /
  // vehicle_not_owned error frame to a specific subscribe: the wire
  // ErrorPayload carries no vehicleId or requestId (verified against
  // @myrobotaxi/contracts), so any client-side FIFO correlation is a
  // guess — and was provably wrong after the 2nd subscribe in a
  // connection. Such errors surface UNATTRIBUTED via the normal
  // {kind:'error'} path; honest per-vehicle rejection needs an
  // ErrorPayload contract change (filed as a follow-up divergence).
  private receiveAll = true;
  private readonly subscribedVehicles = new Set<string>();
  // subscribe frames requested before auth_ok — flushed on auth_ok.
  private pendingSubscribes: string[] = [];

  private readonly logger: Logger;
  private readonly metrics: MetricsRecorder;
  private readonly url: string;
  private readonly getToken: () => Promise<string>;
  private readonly heartbeatMs: number;
  private readonly watchdogMs: number;
  private readonly maxAttempts: number;
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
    this.maxAttempts = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
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

  /** Observe the client's event stream (connectionState / frame /
   *  error). Returns an unsubscribe fn. (Was `subscribe` in MYR-50;
   *  renamed in MYR-83 so `subscribe` is the per-vehicle wire
   *  subscription per the contract — safe pre-1.0, no external
   *  consumers yet.) */
  onEvent(listener: ClientListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- per-vehicle subscription (MYR-83, websocket-protocol §5.2) --------

  /** Register interest in one vehicle. Flips the client to selective
   *  mode (frames for vehicles outside the subscribed set are dropped
   *  client-side, defense-in-depth). Idempotent per vehicleId — the wire
   *  emits at most one `subscribe` frame per id (React 18 strict-mode
   *  double-mount safe). Returns a `Subscription` handle. */
  subscribe(vehicleId: string): Subscription {
    // Post-destroy: no state mutation, no queued send (consistent with
    // connect / retry / disconnect). Hand back an inert handle so callers
    // — e.g. a React effect cleanup — don't have to null-check.
    if (this.destroyed) {
      return {
        vehicleId,
        unsubscribe: () => {
          /* inert — client destroyed */
        },
      };
    }
    this.receiveAll = false;
    if (!this.subscribedVehicles.has(vehicleId)) {
      this.subscribedVehicles.add(vehicleId);
      this.sendSubscribe(vehicleId);
    }
    return {
      vehicleId,
      unsubscribe: () => this.unsubscribe(vehicleId),
    };
  }

  /** Opt into legacy fan-out: receive every owned vehicle (the server
   *  already seeds the connection's set from ownership at handshake,
   *  MYR-46). Clears any selective set + disables the client-side drop. */
  subscribeAll(): void {
    if (this.destroyed) return;
    // Effective IMMEDIATELY, client-side: clearing the set + receiveAll
    // disables the defensive drop now (not "next reconnect"). No wire
    // frame is needed — under DV-07 the server already fans out every
    // owned vehicle, and once a real subscribe contract lands the empty
    // set simply means "no client-side filter".
    this.receiveAll = true;
    this.subscribedVehicles.clear();
    this.pendingSubscribes = [];
  }

  /** Current explicitly-subscribed vehicles (empty in legacy fan-out
   *  mode — the set is server-driven there). Read-only copy. */
  getSubscribedVehicles(): ReadonlySet<string> {
    return new Set(this.subscribedVehicles);
  }

  private unsubscribe(vehicleId: string): void {
    if (!this.subscribedVehicles.delete(vehicleId)) return; // idempotent
    if (this.state === 'connected' && this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: 'unsubscribe', payload: { vehicleId } }));
      } catch {
        /* socket gone — the set removal already stops client-side apply */
      }
    }
  }

  private sendSubscribe(vehicleId: string): void {
    if (this.state === 'connected' && this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: 'subscribe', payload: { vehicleId } }));
      } catch {
        /* will be re-emitted on the next auth_ok */
      }
    } else {
      // Queue until auth_ok (websocket-protocol §5.2 — subscribe only
      // valid post-handshake).
      if (!this.pendingSubscribes.includes(vehicleId)) {
        this.pendingSubscribes.push(vehicleId);
      }
    }
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
        if (this.destroyed) return; // no dangling reconnect timer post-destroy
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
      // Re-establish per-vehicle subscriptions across (re)connects
      // (state-machine §1.3 C-9→C-3): flush anything queued pre-auth_ok,
      // then re-emit every still-subscribed vehicle. The subscribed set
      // survives reconnects automatically.
      const toSend = new Set<string>([
        ...this.pendingSubscribes,
        ...this.subscribedVehicles,
      ]);
      this.pendingSubscribes = [];
      for (const vehicleId of toSend) {
        if (this.subscribedVehicles.has(vehicleId)) this.sendSubscribe(vehicleId);
      }
      return;
    }

    if (type === 'error') {
      const core = wsErrorToCoreError(
        (msg.payload ?? { code: 'internal_error', message: 'error' }) as never,
      );

      this.emitError(core);
      // auth_failed_total{subCode} — SCOPED to auth_failed only (MYR-103),
      // mirroring the REST client (MYR-82, rest/http.ts): an error frame
      // can be rate_limited / internal_error / not_found / etc., and
      // folding those into auth_failed_total would mislead operators. The
      // {subCode} tag shape stays identical so one dashboard sums both
      // carriers ('reauth_required' | 'null').
      if (core.code === 'auth_failed') {
        this.metrics.counter(Metric.AUTH_FAILED, {
          subCode: 'subCode' in core && core.subCode ? core.subCode : 'null',
        });
      }
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

    // Defense-in-depth (MYR-83): in selective mode, drop any
    // vehicle-scoped frame for a vehicle we are not subscribed to —
    // guards against a server-side fan-out race. Never applied in
    // legacy fan-out mode (no client-side filter there).
    if (!this.receiveAll) {
      const vid = (msg.payload as { vehicleId?: string } | undefined)?.vehicleId;
      if (vid && !this.subscribedVehicles.has(vid)) {
        this.logger.debug('ws: dropping frame for unsubscribed vehicle', {
          vehicleId: vid,
          type,
        });
        return;
      }
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
    if (this.attempt >= this.maxAttempts) {
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
