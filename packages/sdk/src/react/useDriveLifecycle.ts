// useDriveLifecycle(handler) — fire-and-forget drive_started /
// drive_ended notifications (FR-3.1) for toasts / route transitions
// (MYR-53). A side-effect hook: it does NOT re-render the consumer (a
// lifecycle event is a one-shot, not render state — use useVehicleState
// for the drive's reconciled state). The handler is held in a ref so
// changing its identity each render does not resubscribe the listener.

import { useEffect, useRef } from 'react';

import { useSdk } from './context.js';

export interface DriveLifecycleEvent {
  readonly type: 'drive_started' | 'drive_ended';
  readonly payload: unknown;
}

export type DriveLifecycleHandler = (event: DriveLifecycleEvent) => void;

export function useDriveLifecycle(handler: DriveLifecycleHandler): void {
  const { client } = useSdk();
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(
    () =>
      client.onEvent((e) => {
        if (e.kind === 'frame' && (e.type === 'drive_started' || e.type === 'drive_ended')) {
          ref.current({ type: e.type, payload: e.payload });
        }
      }),
    [client],
  );
}
