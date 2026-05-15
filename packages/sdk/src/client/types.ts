// WebSocket client types (MYR-50). Connection state machine per
// state-machine.md §1; handshake + watchdog per websocket-protocol.md
// §2 / §7.4.

import type { Logger } from '../observability/logger.js';
import type { MetricsRecorder } from '../observability/metrics.js';
import type { CoreError } from '../errors/core-error.js';

/** state-machine.md §1.2. */
export type ConnectionState =
  | 'initializing'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

/** Minimal structural interface satisfied by both the browser `WebSocket`
 *  and the Node `ws` package — so the core stays isomorphic (NFR-3.33)
 *  with zero hard runtime deps. Consumers on Node inject `ws`; tests
 *  inject a mock. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: ((this: WebSocketLike, ev: unknown) => void) | null;
  onmessage: ((this: WebSocketLike, ev: { data: unknown }) => void) | null;
  onclose: ((this: WebSocketLike, ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((this: WebSocketLike, ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface MyRoboTaxiClientOptions {
  /** WSS endpoint, e.g. `wss://telemetry.example.com/api/ws`. */
  readonly url: string;
  /** Returns a fresh auth token. Called before every (re)connect.
   *  The SDK never stores it (FR-6.1); it is P1 and never logged. */
  readonly getToken: () => Promise<string>;
  /** Consumer logger. Auto-wrapped with RedactingLogger (FR-11.2) so a
   *  raw logger can never see the P1 token / userId. */
  readonly logger?: Logger;
  readonly metrics?: MetricsRecorder;
  /** Server heartbeat cadence (default 15000 ms, websocket-protocol §7.4).
   *  The post-`auth_ok` liveness watchdog fires at 2× this. */
  readonly heartbeatIntervalMs?: number;
  /** Total connection attempts INCLUDING the first (not "retries after
   *  the initial"). `maxAttempts: 1` → one attempt, no reconnect. Default
   *  unbounded (NFR-3.10). Named to match the REST client's `maxAttempts`. */
  readonly maxAttempts?: number;
  /** WebSocket constructor. Defaults to `globalThis.WebSocket` (browser).
   *  Node consumers pass `(url) => new WS(url)` from the `ws` package. */
  readonly webSocketFactory?: WebSocketFactory;
}

export type ClientEvent =
  | {
      readonly kind: 'connectionState';
      readonly from: ConnectionState;
      readonly to: ConnectionState;
      readonly reason?: string;
    }
  | { readonly kind: 'frame'; readonly type: string; readonly payload: unknown }
  | { readonly kind: 'error'; readonly error: CoreError };

export type ClientListener = (event: ClientEvent) => void;
