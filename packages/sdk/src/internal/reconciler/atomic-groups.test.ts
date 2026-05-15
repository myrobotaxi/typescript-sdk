import { describe, expect, it } from 'vitest';

import { checkGroup, GROUP_FIELDS, GROUP_NAMES, groupOf, groupsTouched } from './atomic-groups';

describe('atomic-groups topology (vehicle-state-schema.md §2)', () => {
  it('has exactly the four documented groups', () => {
    expect([...GROUP_NAMES].sort()).toEqual(['charge', 'gear', 'gps', 'navigation']);
  });

  it('routes each field to its group', () => {
    expect(groupOf('latitude')).toBe('gps');
    expect(groupOf('longitude')).toBe('gps');
    expect(groupOf('heading')).toBe('gps');
    expect(groupOf('gearPosition')).toBe('gear');
    expect(groupOf('status')).toBe('gear');
    expect(groupOf('chargeLevel')).toBe('charge');
    expect(groupOf('destinationName')).toBe('navigation');
    expect(groupOf('navRouteCoordinates')).toBe('navigation');
  });

  it('treats ungrouped fields as ungrouped (state-machine §4.3)', () => {
    expect(groupOf('speed')).toBeUndefined();
    expect(groupOf('odometerMiles')).toBeUndefined();
    expect(groupOf('locationName')).toBeUndefined();
    expect(groupOf('vehicleId')).toBeUndefined();
  });

  it('groupsTouched collects every group present in an update', () => {
    const s = groupsTouched({ latitude: 1, gearPosition: 'D', speed: 60 });
    expect([...s].sort()).toEqual(['gear', 'gps']);
  });

  it('navigation group membership matches the schema x-atomic-groups', () => {
    expect([...GROUP_FIELDS.navigation]).toEqual([
      'destinationName',
      'destinationAddress',
      'destinationLatitude',
      'destinationLongitude',
      'originLatitude',
      'originLongitude',
      'etaMinutes',
      'tripDistanceRemaining',
      'navRouteCoordinates',
    ]);
  });
});

describe('checkGroup — navigation predicates (vehicle-state-schema §3)', () => {
  it('all-null is a clear', () => {
    const m = Object.fromEntries(GROUP_FIELDS.navigation.map((f) => [f, null]));
    expect(checkGroup('navigation', m, false)).toEqual({ ok: true, clear: true });
  });

  it('rejects mismatched destination coordinate pair', () => {
    const r = checkGroup('navigation', { destinationLatitude: 37.7, destinationLongitude: null }, false);
    expect(r.ok).toBe(false);
  });

  it('rejects destinationName without coords + route', () => {
    const r = checkGroup('navigation', { destinationName: 'Office' }, false);
    expect(r.ok).toBe(false);
  });

  it('accepts a complete nav set', () => {
    const r = checkGroup(
      'navigation',
      {
        destinationName: 'Office',
        destinationAddress: '500 Howard St',
        destinationLatitude: 37.7,
        destinationLongitude: -122.4,
        originLatitude: 37.8,
        originLongitude: -122.4,
        etaMinutes: 12,
        tripDistanceRemaining: 3.4,
        navRouteCoordinates: [[37.7, -122.4]],
      },
      false,
    );
    expect(r).toEqual({ ok: true, clear: false });
  });

  it('snapshot enforces strict all-or-nothing; live frame does not', () => {
    const partial = {
      destinationName: 'Office',
      destinationAddress: '500 Howard St',
      destinationLatitude: 37.7,
      destinationLongitude: -122.4,
      originLatitude: 37.8,
      originLongitude: -122.4,
      etaMinutes: null, // mid-accumulation
      tripDistanceRemaining: null,
      navRouteCoordinates: [[37.7, -122.4]],
    };
    expect(checkGroup('navigation', partial, true).ok).toBe(false); // snapshot strict
    expect(checkGroup('navigation', partial, false).ok).toBe(true); // live lenient
  });
});

describe('checkGroup — gps / charge / gear', () => {
  it('gps requires lat/lng together and heading present', () => {
    expect(checkGroup('gps', { latitude: 37.7, longitude: null }, false).ok).toBe(false);
    expect(checkGroup('gps', { latitude: 37.7, longitude: -122.4, heading: null }, false).ok).toBe(
      false,
    );
    expect(checkGroup('gps', { latitude: 37.7, longitude: -122.4, heading: 90 }, false).ok).toBe(
      true,
    );
  });

  it('charge snapshot requires chargeLevel + estimatedRange', () => {
    expect(checkGroup('charge', { chargeLevel: null, estimatedRange: 200 }, true).ok).toBe(false);
    expect(checkGroup('charge', { chargeLevel: 75, estimatedRange: 200 }, true).ok).toBe(true);
  });

  it('charge live tolerates null chargeState/timeToFull', () => {
    expect(
      checkGroup('charge', { chargeLevel: 75, estimatedRange: 200, chargeState: null, timeToFull: null }, false)
        .ok,
    ).toBe(true);
  });

  it('gear: D/R requires driving, P/N requires parked-ish', () => {
    expect(checkGroup('gear', { gearPosition: 'D', status: 'parked' }, false).ok).toBe(false);
    expect(checkGroup('gear', { gearPosition: 'D', status: 'driving' }, false).ok).toBe(true);
    expect(checkGroup('gear', { gearPosition: 'P', status: 'driving' }, false).ok).toBe(false);
    expect(checkGroup('gear', { gearPosition: 'P', status: 'charging' }, false).ok).toBe(true);
    expect(checkGroup('gear', { gearPosition: null, status: 'offline' }, false).ok).toBe(true);
  });
});
