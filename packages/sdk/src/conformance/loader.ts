// Conformance fixture types + manifest builder (MYR-55). PURE — no
// node:fs, so it stays inside the isomorphic src typecheck (NFR-3.33).
// The fixture *files* are read by the test (a `*.test.ts`, excluded from
// the src typecheck and run in vitest's node env). `manifest.json` is
// the generated, committed, cross-SDK artifact the Swift P4 conformance
// suite consumes — one source of truth for both SDKs.
//
// NFR-3.45: this corpus is a v1 ship gate.

export type FixtureKind = 'ws_error' | 'rest_error' | 'reconciler' | 'frame_parse';

export interface Fixture {
  readonly name: string;
  readonly kind: FixtureKind;
  readonly input: unknown;
  readonly expect: unknown;
  /** Path relative to the `fixtures/` dir, e.g. `edge-cases/x`. */
  readonly relPath: string;
}

export interface Manifest {
  /** Bump when the fixture schema (not the data) changes. */
  readonly schema: 1;
  readonly count: number;
  readonly fixtures: readonly Fixture[];
}

/** Validate a parsed JSON blob is a well-formed fixture. */
export function parseFixture(relPath: string, data: unknown): Fixture {
  const f = data as Partial<Fixture>;
  if (!f || !f.name || !f.kind || !('input' in f) || !('expect' in f)) {
    throw new Error(`conformance: malformed fixture ${relPath}`);
  }
  return { name: f.name, kind: f.kind, input: f.input, expect: f.expect, relPath };
}

export function buildManifest(fixtures: readonly Fixture[]): Manifest {
  const sorted = [...fixtures].sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { schema: 1, count: sorted.length, fixtures: sorted };
}
