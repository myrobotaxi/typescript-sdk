// Contract conformance suite (MYR-55). One test per canonical fixture,
// driven through the REAL SDK code paths (not re-implementations):
// wsErrorToCoreError / restErrorToCoreError / the reconciler. A drift
// test keeps the Swift-consumable manifest.json in sync with the
// per-file corpus. NFR-3.45 ship gate; runs in the standard `test` CI
// check so it blocks merge on any contract-touching PR.
//
// fs lives here (a *.test.ts is excluded from the isomorphic src
// typecheck and runs in vitest's node env); loader.ts stays pure.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { restErrorToCoreError, wsErrorToCoreError } from '../errors/core-error';
import type { CoreError, CoreErrorCode, CoreErrorSubCode } from '../errors/core-error';
import type { ErrorPayload } from '@myrobotaxi/contracts/types';
import { Reconciler } from '../internal/reconciler/index';
import type { DataStateMap } from '../internal/reconciler/index';
import { buildManifest, parseFixture } from './loader';
import type { Fixture } from './loader';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

function walk(dir: string, prefix = ''): Fixture[] {
  const out: Fixture[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(`${dir}${entry.name}/`, rel));
    } else if (entry.name.endsWith('.json')) {
      const data = JSON.parse(readFileSync(`${dir}${entry.name}`, 'utf8')) as unknown;
      out.push(parseFixture(rel.replace(/\.json$/, ''), data));
    }
  }
  return out;
}

const fixtures = walk(FIXTURES_DIR).sort((a, b) => a.relPath.localeCompare(b.relPath));

function assertCoreError(core: CoreError, exp: Record<string, unknown>): void {
  expect(core.code).toBe(exp.code);
  expect(core.retryable).toBe(exp.retryable);
  expect(core.terminal).toBe(exp.terminal);
  if ('subCode' in exp) {
    expect((core as { subCode?: string }).subCode).toBe(exp.subCode);
  }
  if ('retryAfterSec' in exp) {
    expect((core as { retryAfterSec?: number }).retryAfterSec).toBe(exp.retryAfterSec);
  }
}

describe('contract conformance corpus (MYR-55)', () => {
  it('loaded a non-empty, well-formed corpus', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const f of fixtures) {
    it(`[${f.kind}] ${f.relPath}`, () => {
      const exp = f.expect as Record<string, unknown>;
      switch (f.kind) {
        case 'ws_error': {
          assertCoreError(wsErrorToCoreError(f.input as ErrorPayload), exp);
          break;
        }
        case 'rest_error': {
          const i = f.input as {
            code: CoreErrorCode;
            httpStatus: number;
            subCode?: CoreErrorSubCode;
            retryAfterSec?: number;
          };
          assertCoreError(
            restErrorToCoreError(i.code, i.httpStatus, {
              subCode: i.subCode,
              retryAfterSec: i.retryAfterSec,
            }),
            exp,
          );
          break;
        }
        case 'reconciler': {
          const i = f.input as {
            snapshot: Record<string, unknown>;
            updates: Record<string, unknown>[];
          };
          const r = new Reconciler();
          r.applySnapshot(i.snapshot);
          for (const u of i.updates) r.applyVehicleUpdate(u);
          const view = r.getView();
          const expDs = (exp.dataState ?? {}) as Partial<DataStateMap>;
          for (const [group, state] of Object.entries(expDs)) {
            expect(view.dataState[group as keyof DataStateMap]).toBe(state);
          }
          if (exp.vehicle) {
            for (const [k, v] of Object.entries(exp.vehicle as Record<string, unknown>)) {
              expect((view.vehicle as Record<string, unknown> | null)?.[k]).toEqual(v);
            }
          }
          break;
        }
        case 'frame_parse': {
          // The wire discriminator the WS client routes on must survive a
          // JSON round-trip unchanged (contract: envelope.type is stable).
          const round = JSON.parse(JSON.stringify(f.input)) as { type?: string };
          expect(round.type).toBe((exp as { type: string }).type);
          break;
        }
      }
    });
  }

  // Cross-SDK drift guard: the committed manifest.json (consumed by the
  // Swift P4 conformance suite) must equal what the loader produces. To
  // regenerate after editing fixtures: `UPDATE_MANIFEST=1 npm test`.
  it('manifest.json is in sync with the fixture corpus', () => {
    const manifestPath = fileURLToPath(new URL('./manifest.json', import.meta.url));
    const fresh = buildManifest(fixtures);
    if (process.env.UPDATE_MANIFEST === '1') {
      writeFileSync(manifestPath, JSON.stringify(fresh, null, 2) + '\n');
    }
    const committed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    expect(committed).toEqual(fresh);
  });
});
