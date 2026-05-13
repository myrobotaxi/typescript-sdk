import { describe, expect, it } from 'vitest';

import { REDACTED, redactP1 } from './redact';

describe('redactP1 — flat-object P1 keys', () => {
  it.each([
    ['latitude', 37.7749],
    ['longitude', -122.4194],
    ['lat', 37.7749],
    ['lng', -122.4194],
    ['destinationLatitude', 37.0],
    ['destinationLongitude', -122.0],
    ['originLatitude', 37.0],
    ['originLongitude', -122.0],
    ['locationName', 'Home'],
    ['locationAddress', '1 Market St'],
    ['destinationName', 'Office'],
    ['destinationAddress', '500 Howard St'],
    ['startLocation', 'Home'],
    ['startAddress', '1 Market St'],
    ['endLocation', 'Office'],
    ['endAddress', '500 Howard St'],
    ['address', '500 Howard St'],
    ['licensePlate', 'ABC1234'],
    ['email', 'user@example.com'],
    ['userEmail', 'user@example.com'],
    ['name', 'Alice'],
    ['userName', 'Alice'],
    ['image', 'https://avatar.example.com/u/42.png'],
    ['token', 'eyJ...'],
    ['accessToken', 'eyJ...'],
    ['refreshToken', 'eyJ...'],
    ['idToken', 'eyJ...'],
  ])('redacts %s', (key, value) => {
    const out = redactP1({ [key]: value });
    expect(out[key]).toBe(REDACTED);
  });

  it('redacts snake_case token variants', () => {
    const out = redactP1({
      access_token: 'eyJ-access',
      refresh_token: 'eyJ-refresh',
      id_token: 'eyJ-id',
    });
    expect(out.access_token).toBe(REDACTED);
    expect(out.refresh_token).toBe(REDACTED);
    expect(out.id_token).toBe(REDACTED);
  });
});

describe('redactP1 — non-P1 fields preserved', () => {
  it('preserves opaque P0 ids', () => {
    const out = redactP1({
      vehicleId: 'clxyz1234567890abcdef',
      driveId: 'clabc1234567890ghijkl',
      userId: 'clmno1234567890pqrstu',
      accountId: 'clacc1234567890acctok',
      inviteId: 'clinv1234567890invite',
      id: 'cl1234567890',
    });
    expect(out).toEqual({
      vehicleId: 'clxyz1234567890abcdef',
      driveId: 'clabc1234567890ghijkl',
      userId: 'clmno1234567890pqrstu',
      accountId: 'clacc1234567890acctok',
      inviteId: 'clinv1234567890invite',
      id: 'cl1234567890',
    });
  });

  it('preserves status enums + numeric P0 fields', () => {
    const out = redactP1({
      status: 'driving',
      chargeLevel: 75,
      speed: 60,
      heading: 90,
    });
    expect(out).toEqual({
      status: 'driving',
      chargeLevel: 75,
      speed: 60,
      heading: 90,
    });
  });

  it('preserves non-P1 fields alongside P1 fields', () => {
    const out = redactP1({
      vehicleId: 'clxyz1234567890abcdef',
      latitude: 37.7749,
      longitude: -122.4194,
      status: 'driving',
    });
    expect(out).toEqual({
      vehicleId: 'clxyz1234567890abcdef',
      latitude: REDACTED,
      longitude: REDACTED,
      status: 'driving',
    });
  });
});

describe('redactP1 — VIN special case', () => {
  it('redacts vin to ***XXXX (last 4)', () => {
    expect(redactP1({ vin: '5YJ3E1EA7KF000123' })).toEqual({ vin: '***0123' });
  });

  it('falls back to [REDACTED] for short / non-string vin values', () => {
    expect(redactP1({ vin: 'ABC' })).toEqual({ vin: REDACTED });
    expect(redactP1({ vin: 12345 })).toEqual({ vin: REDACTED });
    expect(redactP1({ vin: null })).toEqual({ vin: REDACTED });
  });
});

describe('redactP1 — containment rule', () => {
  it('redacts a parent object that has a P1 descendant', () => {
    const out = redactP1({
      vehicle: { vehicleId: 'clxyz', latitude: 37.7749 },
    });
    expect(out.vehicle).toBe(REDACTED);
  });

  it('redacts an array containing P1 descendants', () => {
    const out = redactP1({
      routePoints: [
        { lat: 37.7749, lng: -122.4194, ts: 1 },
        { lat: 37.78, lng: -122.42, ts: 2 },
      ],
    });
    expect(out.routePoints).toBe(REDACTED);
  });

  it('redacts deeply nested containers (3 levels)', () => {
    const out = redactP1({
      level1: { level2: { level3: { latitude: 37.7749 } } },
    });
    expect((out as Record<string, unknown>).level1).toBe(REDACTED);
  });

  it('does NOT redact containers whose descendants are all P0', () => {
    const out = redactP1({
      vehicle: { vehicleId: 'clxyz', status: 'driving', chargeLevel: 75 },
    });
    expect(out.vehicle).toEqual({
      vehicleId: 'clxyz',
      status: 'driving',
      chargeLevel: 75,
    });
  });

  it('redacts the route polyline container by key name even without a P1 child', () => {
    // navRouteCoordinates / routePoints / routeCoordinates are always P1
    // by key alone — covered by isP1Key, not just containment.
    const out = redactP1({ navRouteCoordinates: [{ ts: 1 }, { ts: 2 }] });
    expect(out.navRouteCoordinates).toBe(REDACTED);
  });
});

describe('redactP1 — edge cases', () => {
  it('handles undefined / null inputs', () => {
    expect(redactP1(undefined)).toBeUndefined();
    expect(redactP1(null)).toBeNull();
  });

  it('handles primitive inputs', () => {
    expect(redactP1('hello')).toBe('hello');
    expect(redactP1(42)).toBe(42);
    expect(redactP1(true)).toBe(true);
  });

  it('handles empty objects + arrays', () => {
    expect(redactP1({})).toEqual({});
    expect(redactP1([])).toEqual([]);
  });

  it('is idempotent (running on already-redacted output is a no-op)', () => {
    const once = redactP1({ latitude: 37.7749, vehicleId: 'clxyz' });
    const twice = redactP1(once);
    expect(twice).toEqual(once);
  });

  it('does not mutate the input', () => {
    const input = { latitude: 37.7749, vehicleId: 'clxyz' };
    const inputCopy = { ...input };
    redactP1(input);
    expect(input).toEqual(inputCopy);
  });

  it('handles cyclic inputs without stack overflow', () => {
    interface Cyclic { vehicleId: string; self?: Cyclic }
    const a: Cyclic = { vehicleId: 'clxyz' };
    a.self = a; // cycle
    const out = redactP1(a);
    expect(out.vehicleId).toBe('clxyz');
    // Back-edge becomes REDACTED rather than infinite recursion.
    expect(out.self).toBe(REDACTED);
  });

  it('handles cyclic inputs with a P1 child by containment', () => {
    interface CyclicP1 { latitude: number; self?: CyclicP1 }
    const a: CyclicP1 = { latitude: 37.7749 };
    a.self = a;
    const out = redactP1(a);
    expect(out.latitude).toBe(REDACTED);
    // The container `self` points back to a node holding P1, so containment
    // rule redacts it too. Either via key-level (latitude) or back-edge
    // (cycle guard) — both produce the same outcome: P1 doesn't escape.
    expect(out.self).toBe(REDACTED);
  });
});
