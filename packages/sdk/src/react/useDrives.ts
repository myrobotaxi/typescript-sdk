// useDrives(vehicleId, opts) — cursor-paginated recent drives over REST
// (rest-api.md §4.2 / MYR-80). Not reconciled state — it's a one-shot
// list with explicit `loadMore()`. Aborts the in-flight request on
// unmount or vehicleId change so a late response can't clobber a newer
// vehicle's list (and never sets state after unmount).

import { useCallback, useEffect, useRef, useState } from 'react';

import type { CoreError } from '../errors/core-error.js';
import type { DriveSummary } from '../rest/rest-client.js';
import { useSdk } from './context.js';

export interface UseDrivesOptions {
  /** Page size (rest-api.md §4.2.1). Server clamps; default server-side. */
  readonly limit?: number;
}

export interface UseDrivesResult {
  readonly drives: readonly DriveSummary[];
  readonly loading: boolean;
  readonly error: CoreError | null;
  readonly hasMore: boolean;
  /** Fetch the next page and append. No-op while loading or exhausted. */
  loadMore(): void;
  /** Discard current results and re-fetch page 1. */
  refresh(): void;
}

export function useDrives(vehicleId: string, opts: UseDrivesOptions = {}): UseDrivesResult {
  const { rest } = useSdk();
  const { limit } = opts;

  const [drives, setDrives] = useState<readonly DriveSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CoreError | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  // Bumped on vehicleId change / refresh; a fetch tagged with a stale
  // epoch discards its result (no torn list, no set-after-unmount).
  const epochRef = useRef(0);

  const fetchPage = useCallback(
    (reset: boolean) => {
      if (loadingRef.current) return;
      if (!reset && (!hasMore || cursorRef.current === null)) return;
      loadingRef.current = true;
      setLoading(true);
      const epoch = epochRef.current;
      const controller = new AbortController();
      const cursor = reset ? undefined : (cursorRef.current ?? undefined);

      void rest.drives
        .list(vehicleId, { cursor, limit }, { signal: controller.signal })
        .then((res) => {
          if (epoch !== epochRef.current) return; // superseded
          loadingRef.current = false;
          setLoading(false);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          setError(null);
          cursorRef.current = res.data.nextCursor;
          setHasMore(res.data.hasMore);
          setDrives((prev) => (reset ? res.data.items : [...prev, ...res.data.items]));
        });

      return () => controller.abort();
    },
    [rest, vehicleId, limit, hasMore],
  );

  useEffect(() => {
    epochRef.current += 1;
    loadingRef.current = false;
    cursorRef.current = null;
    setDrives([]);
    setError(null);
    setHasMore(false);
    const cancel = fetchPage(true);
    return () => {
      epochRef.current += 1; // invalidate any in-flight result
      cancel?.();
    };
    // Intentionally keyed only on vehicleId/limit/rest (a page-1 reset).
    // `fetchPage` is deliberately excluded — it closes over `hasMore`,
    // and re-running this effect on every hasMore flip would re-fetch
    // page 1 mid-pagination. loadMore() uses the latest fetchPage.
  }, [vehicleId, limit, rest]);

  const loadMore = useCallback(() => {
    fetchPage(false);
  }, [fetchPage]);

  const refresh = useCallback(() => {
    epochRef.current += 1;
    loadingRef.current = false;
    cursorRef.current = null;
    fetchPage(true);
  }, [fetchPage]);

  return { drives, loading, error, hasMore, loadMore, refresh };
}
