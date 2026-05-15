// useConnectionState() — the WS connection state (state-machine.md §1),
// re-rendering on every transition (MYR-53). Tear-free via
// useSyncExternalStore; `client.connectionState` is the synchronous
// source of truth so SSR / first paint reflects the real state.

import { useCallback } from 'react';
import { useSyncExternalStore } from 'react';

import type { ConnectionState } from '../client/types.js';
import { useSdk } from './context.js';

export function useConnectionState(): ConnectionState {
  const { client } = useSdk();

  const subscribe = useCallback(
    (onChange: () => void) =>
      client.onEvent((e) => {
        if (e.kind === 'connectionState') onChange();
      }),
    [client],
  );
  const getSnapshot = useCallback(() => client.connectionState, [client]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
