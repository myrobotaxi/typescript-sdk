// Internal reconciler module (MYR-51). NOT part of the SDK public API —
// no package.json `exports` subpath, not re-exported from src/index.ts.
// Consumed within the package by the WS client (MYR-50) and the React
// hooks (MYR-53) via relative import.

export { Reconciler } from './reconciler.js';
export type { ReconcilerOptions } from './reconciler.js';
export type {
  ChangeEvent,
  DataState,
  DataStateMap,
  DriveLifecycle,
  DriveSummary,
  GroupName,
  Listener,
  ReconcilerView,
} from './types.js';
export { GROUP_FIELDS, GROUP_NAMES, groupOf, UNGROUPED_FIELDS } from './atomic-groups.js';
