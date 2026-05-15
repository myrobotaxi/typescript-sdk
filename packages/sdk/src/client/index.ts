// Public WebSocket client surface (MYR-50).

export { MyRoboTaxiClient } from './ws-client.js';
export { computeBackoffMs, BACKOFF } from './backoff.js';
export type {
  ClientEvent,
  ClientListener,
  ConnectionState,
  MyRoboTaxiClientOptions,
  WebSocketFactory,
  WebSocketLike,
} from './types.js';
