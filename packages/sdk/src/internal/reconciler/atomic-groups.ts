// Atomic-group topology + consistency predicates.
//
// Source of truth: vehicle-state-schema.md §2 / the `x-atomic-groups`
// annotation in vehicle-state.schema.json, and state-machine.md §4.3
// (field-to-group routing). The schema's `x-atomic-groups` is a custom
// annotation that the codegen folds into TSDoc only — it is NOT available
// as runtime data in the generated types, and bundling the raw JSON
// schema (~18 KB) would blow the NFR-3.30 core budget. So the topology
// is encoded here as a small const; `atomic-groups.test.ts` guards it
// against the contract by asserting membership matches the documented
// groups, and MYR-55's fixture suite will drive the live cross-check.

import type { VehicleState } from '@myrobotaxi/contracts/types';
import type { GroupName } from './types.js';

type Field = keyof VehicleState;

/** Field membership per atomic group (vehicle-state-schema.md §2). */
export const GROUP_FIELDS: Readonly<Record<GroupName, readonly Field[]>> = {
  navigation: [
    'destinationName',
    'destinationAddress',
    'destinationLatitude',
    'destinationLongitude',
    'originLatitude',
    'originLongitude',
    'etaMinutes',
    'tripDistanceRemaining',
    'navRouteCoordinates',
  ],
  charge: ['chargeLevel', 'chargeState', 'estimatedRange', 'timeToFull'],
  gps: ['latitude', 'longitude', 'heading'],
  gear: ['gearPosition', 'status'],
} as const;

/** Ungrouped fields update individually and have no `dataState` dimension
 *  (state-machine.md §4.3 — "Ungrouped fields"). */
export const UNGROUPED_FIELDS: readonly Field[] = [
  'speed',
  'odometerMiles',
  'interiorTemp',
  'exteriorTemp',
  'fsdMilesSinceReset',
  'locationName',
  'locationAddress',
];

const FIELD_TO_GROUP: ReadonlyMap<Field, GroupName> = new Map(
  (Object.entries(GROUP_FIELDS) as [GroupName, readonly Field[]][]).flatMap(
    ([group, fields]) => fields.map((f) => [f, group] as const),
  ),
);

export const GROUP_NAMES: readonly GroupName[] = Object.keys(GROUP_FIELDS) as GroupName[];

/** Returns the atomic group a field belongs to, or `undefined` if ungrouped. */
export function groupOf(field: string): GroupName | undefined {
  return FIELD_TO_GROUP.get(field as Field);
}

/** Which groups does this set of updated field names touch? */
export function groupsTouched(fields: Readonly<Record<string, unknown>>): Set<GroupName> {
  const out = new Set<GroupName>();
  for (const key of Object.keys(fields)) {
    const g = groupOf(key);
    if (g) out.add(g);
  }
  return out;
}

function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}

/**
 * Result of validating a group's resulting state against its consistency
 * predicates (vehicle-state-schema.md §3). `clear` means every field in
 * the group is null — the atomic-clear signal (FR-2.3, NFR-3.9).
 */
export interface GroupCheck {
  readonly ok: boolean;
  readonly clear: boolean;
  readonly reason?: string;
}

/**
 * Validate a group's merged field values.
 *
 * `isSnapshot` toggles the stricter all-or-nothing navigation predicate:
 * the DB snapshot MUST be all-or-nothing, but live frames MAY carry
 * `etaMinutes` / `tripDistanceRemaining` as null independently during the
 * server's 500 ms accumulation window (vehicle-state-schema.md §2 nav
 * predicate 5).
 */
export function checkGroup(
  group: GroupName,
  merged: Readonly<Record<string, unknown>>,
  isSnapshot: boolean,
): GroupCheck {
  switch (group) {
    case 'navigation':
      return checkNavigation(merged, isSnapshot);
    case 'gps':
      return checkGps(merged);
    case 'charge':
      return checkCharge(merged, isSnapshot);
    case 'gear':
      return checkGear(merged);
  }
}

function checkNavigation(m: Readonly<Record<string, unknown>>, isSnapshot: boolean): GroupCheck {
  const fields = GROUP_FIELDS.navigation;
  const allNull = fields.every((f) => isNullish(m[f]));
  if (allNull) return { ok: true, clear: true };

  // Coordinate-pair predicates.
  if (isNullish(m.destinationLatitude) !== isNullish(m.destinationLongitude)) {
    return { ok: false, clear: false, reason: 'destinationLatitude/Longitude must be null together' };
  }
  if (isNullish(m.originLatitude) !== isNullish(m.originLongitude)) {
    return { ok: false, clear: false, reason: 'originLatitude/Longitude must be null together' };
  }
  // destName implies dest coords + route polyline (NFR-3.3).
  if (!isNullish(m.destinationName)) {
    if (
      isNullish(m.destinationLatitude) ||
      isNullish(m.destinationLongitude) ||
      isNullish(m.navRouteCoordinates)
    ) {
      return {
        ok: false,
        clear: false,
        reason: 'destinationName requires destinationLatitude/Longitude/navRouteCoordinates',
      };
    }
  }
  // Strict all-or-nothing only on the DB snapshot; live frames may carry
  // eta/tripDistance independently mid-accumulation.
  if (isSnapshot) {
    const anyNull = fields.some((f) => isNullish(m[f]));
    if (anyNull) {
      return {
        ok: false,
        clear: false,
        reason: 'snapshot navigation group must be all-or-nothing (vehicle-state-schema §2 nav predicate 4/5)',
      };
    }
  }
  return { ok: true, clear: false };
}

function checkGps(m: Readonly<Record<string, unknown>>): GroupCheck {
  const fields = GROUP_FIELDS.gps;
  if (fields.every((f) => isNullish(m[f]))) return { ok: true, clear: true };
  if (isNullish(m.latitude) !== isNullish(m.longitude)) {
    return { ok: false, clear: false, reason: 'latitude/longitude must be present together' };
  }
  if (!isNullish(m.latitude) && isNullish(m.heading)) {
    return { ok: false, clear: false, reason: 'heading must be present when latitude/longitude are' };
  }
  return { ok: true, clear: false };
}

function checkCharge(m: Readonly<Record<string, unknown>>, isSnapshot: boolean): GroupCheck {
  const fields = GROUP_FIELDS.charge;
  if (fields.every((f) => isNullish(m[f]))) return { ok: true, clear: true };
  // chargeState / timeToFull are nullable in steady state; only the DB
  // snapshot must carry chargeLevel + estimatedRange (NFR-3.5).
  if (isSnapshot && (isNullish(m.chargeLevel) || isNullish(m.estimatedRange))) {
    return {
      ok: false,
      clear: false,
      reason: 'snapshot charge group must include chargeLevel + estimatedRange (NFR-3.5)',
    };
  }
  return { ok: true, clear: false };
}

function checkGear(m: Readonly<Record<string, unknown>>): GroupCheck {
  // status is always present; gearPosition nullable (asleep). Not clearable
  // as a unit because status is non-nullable.
  const gp = m.gearPosition;
  const status = m.status;
  if ((gp === 'D' || gp === 'R') && status !== 'driving') {
    return { ok: false, clear: false, reason: `gearPosition ${String(gp)} requires status 'driving'` };
  }
  // P/N → parked unless overridden by charging/offline/in_service.
  if (
    (gp === 'P' || gp === 'N') &&
    status !== 'parked' &&
    status !== 'charging' &&
    status !== 'offline' &&
    status !== 'in_service'
  ) {
    return {
      ok: false,
      clear: false,
      reason: `gearPosition ${String(gp)} requires status parked/charging/offline/in_service`,
    };
  }
  return { ok: true, clear: false };
}
