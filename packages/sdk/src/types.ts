// Public type surface for @myrobotaxi/sdk consumers.
//
// All wire-shape types are re-exported from @myrobotaxi/contracts — the
// canonical, language-neutral source of truth published from
// github.com/myrobotaxi/contracts. The SDK itself does not hand-write
// these types; see CONTRIBUTING.md "Contract source-of-truth" section.
//
// Usage:
//   import type { VehicleState, WebSocketEnvelope } from '@myrobotaxi/sdk/types';

export type {
  VehicleState,
  WebSocketEnvelope,
  WebSocketMessages,
  MessageType,
  AuthPayload,
  AuthOkPayload,
  VehicleUpdatePayload,
  DriveStartedPayload,
  DriveEndedPayload,
  ConnectivityPayload,
  HeartbeatPayload,
  ErrorPayload,
  SubscribePayload,
  UnsubscribePayload,
  PingPayload,
  PongPayload,
} from '@myrobotaxi/contracts/types';
