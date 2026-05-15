// Public typed-error surface (MYR-52). Consumers branch on `CoreError.code`.

export type {
  CoreError,
  CoreErrorCode,
  CoreErrorSubCode,
  Transport,
} from './core-error.js';
export {
  isRetryable,
  isTerminal,
  restErrorToCoreError,
  wsErrorToCoreError,
} from './core-error.js';
