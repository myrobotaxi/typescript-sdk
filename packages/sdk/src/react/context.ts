// React context wiring (MYR-53). Logic-only (NFR-3.32) — no JSX, no UI;
// uses `createElement` so the file stays `.ts` and the build needs no
// JSX tsconfig. The provider owns the ReconnectOrchestrator (MYR-84)
// composed from the consumer-constructed client + REST client. No
// module-level singletons (sdk-typescript.md "no globals").

import { createContext, createElement, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import type { MyRoboTaxiClient } from '../client/ws-client.js';
import type { RestClient } from '../rest/rest-client.js';
import type { Logger } from '../observability/logger.js';
import type { MetricsRecorder } from '../observability/metrics.js';
import { ReconnectOrchestrator } from '../internal/orchestrator/index.js';

export interface SdkContextValue {
  readonly client: MyRoboTaxiClient;
  readonly rest: RestClient;
  readonly orchestrator: ReconnectOrchestrator;
}

const SdkContext = createContext<SdkContextValue | null>(null);

export interface MyRoboTaxiProviderProps {
  readonly client: MyRoboTaxiClient;
  readonly rest: RestClient;
  readonly logger?: Logger;
  readonly metrics?: MetricsRecorder;
  readonly children: ReactNode;
}

/**
 * Holds the orchestrator for the subtree. `start()` on mount, `destroy()`
 * on unmount. React 18 strict-mode double-invokes the effect (mount →
 * unmount → remount); the orchestrator is terminal after `destroy()`, so
 * the ref is cleared on cleanup and a fresh instance is built on remount
 * (lazy ref-init is double-render safe).
 */
export function MyRoboTaxiProvider(props: MyRoboTaxiProviderProps): ReactNode {
  const { client, rest, logger, metrics, children } = props;
  const ref = useRef<ReconnectOrchestrator | null>(null);
  if (ref.current === null) {
    ref.current = new ReconnectOrchestrator({ client, rest, logger, metrics });
  }
  const orchestrator = ref.current;

  useEffect(() => {
    orchestrator.start();
    return () => {
      orchestrator.destroy();
      ref.current = null; // force a fresh instance if we remount
    };
  }, [orchestrator]);

  return createElement(
    SdkContext.Provider,
    { value: { client, rest, orchestrator } },
    children,
  );
}

/** Internal — throws if a hook is used outside the provider. */
export function useSdk(): SdkContextValue {
  const ctx = useContext(SdkContext);
  if (!ctx) {
    throw new Error(
      '@myrobotaxi/sdk/react: hooks must be used inside <MyRoboTaxiProvider>.',
    );
  }
  return ctx;
}
