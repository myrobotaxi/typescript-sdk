// Public typed-error surface (MYR-52). Consumers branch on `CoreError.code`.

export type {
  CoreError,
  CoreErrorCode,
  CoreErrorSubCode,
  ReauthRequiredError,
  Transport,
} from './core-error.js';
export {
  isReauthRequired,
  isRetryable,
  isTerminal,
  restErrorToCoreError,
  wsErrorToCoreError,
} from './core-error.js';
