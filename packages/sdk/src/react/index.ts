// @myrobotaxi/sdk/react — idiomatic React hooks (MYR-53). Logic-only
// (NFR-3.32): no JSX components, no theming, no map renderers. React is
// a peerDependency; this entry is `external`-marked in the build so it
// never bundles a second React.
//
// Tree-shaking: every hook is its own module and these are pure named
// re-exports with `sideEffects:false`, so importing `useVehicleState`
// does not pull `useDrives` into the consumer bundle (NFR-3.30).

export { MyRoboTaxiProvider } from './context.js';
export type { MyRoboTaxiProviderProps, SdkContextValue } from './context.js';

export { useVehicleState } from './useVehicleState.js';
export type { VehicleStateResult } from './useVehicleState.js';

export { useConnectionState } from './useConnectionState.js';

export { useDriveLifecycle } from './useDriveLifecycle.js';
export type { DriveLifecycleEvent, DriveLifecycleHandler } from './useDriveLifecycle.js';

export { useDrives } from './useDrives.js';
export type { UseDrivesOptions, UseDrivesResult } from './useDrives.js';

// Lets a consumer verify the React adapter resolves to the same SDK
// build as the core entry (no dual-package hazard).
export { SDK_VERSION } from '../index.js';
