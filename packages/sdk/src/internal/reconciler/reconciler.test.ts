import { describe, expect, it, vi } from 'vitest';

import type { ChangeEvent } from './types';
import { Reconciler } from './reconciler';

function collect(r: Reconciler): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  r.subscribe((e) => events.push(e));
  return events;
}

const VALID_SNAPSHOT = {
  vehicleId: 'clxyz',
  status: 'parked' as const,
  gearPosition: 'P' as const,
  chargeLevel: 75,
  estimatedRange: 240,
  latitude: 37.7749,
  longitude: -122.4194,
  heading: 90,
  // navigation all-null = no active nav (valid clear-state snapshot)
  destinationName: null,
  destinationAddress: null,
  destinationLatitude: null,
  destinationLongitude: null,
  originLatitude: null,
  originLongitude: null,
  etaMinutes: null,
  tripDistanceRemaining: null,
  navRouteCoordinates: null,
};

describe('Reconciler — snapshot (D-1/D-2)', () => {
  it('loading → ready for valid groups, navigation → cleared (all-null)', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT);
    const v = r.getView();
    expect(v.dataState.gps).toBe('ready');
    expect(v.dataState.charge).toBe('ready');
    expect(v.dataState.gear).toBe('ready');
    expect(v.dataState.navigation).toBe('cleared');
    expect(v.vehicle?.vehicleId).toBe('clxyz');
  });

  it('loading → error (D-2) for a group failing its predicate', () => {
    const r = new Reconciler();
    r.applySnapshot({ ...VALID_SNAPSHOT, chargeLevel: null }); // charge snapshot needs chargeLevel
    expect(r.getView().dataState.charge).toBe('error');
    expect(r.getView().dataState.gps).toBe('ready');
  });

  it('snapshotFailed moves groups to error', () => {
    const r = new Reconciler();
    r.snapshotFailed('network');
    expect(r.getView().dataState.gps).toBe('error');
  });
});

describe('Reconciler — live deltas (D-3/D-5/D-6)', () => {
  it('D-3 ready→ready merges grouped fields atomically', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT);
    r.applyVehicleUpdate({ latitude: 40.0, longitude: -73.0, heading: 180 });
    const v = r.getView();
    expect(v.vehicle?.latitude).toBe(40.0);
    expect(v.vehicle?.heading).toBe(180);
    expect(v.dataState.gps).toBe('ready');
  });

  it('D-6 invalid data → error, retains last-known-good', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT);
    r.applyVehicleUpdate({ latitude: 40.0, longitude: null }); // breaks gps predicate
    const v = r.getView();
    expect(v.dataState.gps).toBe('error');
    expect(v.vehicle?.latitude).toBe(37.7749); // unchanged — last good retained
  });

  it('D-5 atomic clear → cleared, all group fields nulled together', () => {
    const r = new Reconciler();
    r.applySnapshot({
      ...VALID_SNAPSHOT,
      destinationName: 'Office',
      destinationAddress: '500 Howard St',
      destinationLatitude: 37.7,
      destinationLongitude: -122.4,
      originLatitude: 37.8,
      originLongitude: -122.4,
      etaMinutes: 12,
      tripDistanceRemaining: 3.4,
      navRouteCoordinates: [[37.7, -122.4]],
    });
    expect(r.getView().dataState.navigation).toBe('ready');
    // server signals nav cancel: all nav fields null
    r.applyVehicleUpdate({
      destinationName: null,
      destinationAddress: null,
      destinationLatitude: null,
      destinationLongitude: null,
      originLatitude: null,
      originLongitude: null,
      etaMinutes: null,
      tripDistanceRemaining: null,
      navRouteCoordinates: null,
    });
    const v = r.getView();
    expect(v.dataState.navigation).toBe('cleared');
    expect(v.vehicle?.destinationName).toBeNull();
    expect(v.vehicle?.navRouteCoordinates).toBeNull();
  });

  it('D-9 cleared→ready when nav data returns', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT); // nav cleared
    expect(r.getView().dataState.navigation).toBe('cleared');
    r.applyVehicleUpdate({
      destinationName: 'Office',
      destinationAddress: '500 Howard St',
      destinationLatitude: 37.7,
      destinationLongitude: -122.4,
      originLatitude: 37.8,
      originLongitude: -122.4,
      etaMinutes: 12,
      tripDistanceRemaining: 3.4,
      navRouteCoordinates: [[37.7, -122.4]],
    });
    expect(r.getView().dataState.navigation).toBe('ready');
  });

  it('ungrouped fields update without a dataState dimension', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT);
    r.applyVehicleUpdate({ speed: 65, odometerMiles: 12345 });
    expect(r.getView().vehicle?.speed).toBe(65);
  });
});

describe('Reconciler — connection lifecycle (D-4/D-7)', () => {
  it('D-4: disconnect moves ready groups to stale, keeps cached values', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT);
    r.onDisconnected();
    const v = r.getView();
    expect(v.dataState.gps).toBe('stale');
    expect(v.dataState.charge).toBe('stale');
    expect(v.vehicle?.latitude).toBe(37.7749); // NFR-3.12/3.13 cache retained
  });

  it('emits a data_staleness metric per group on disconnect', () => {
    const counter = vi.fn();
    const noop = (): void => undefined;
    const r = new Reconciler({ metrics: { counter, histogram: noop, gauge: noop } });
    r.applySnapshot(VALID_SNAPSHOT);
    r.onDisconnected();
    expect(counter).toHaveBeenCalledWith('data_staleness_events_total', { group: 'gps' });
    expect(counter).toHaveBeenCalledWith('data_staleness_events_total', { group: 'charge' });
  });

  it('D-7: reconnect requested → all groups loading; cache stays', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT);
    r.onDisconnected();
    r.onReconnectRequested();
    const v = r.getView();
    expect(v.dataState.gps).toBe('loading');
    expect(v.vehicle?.latitude).toBe(37.7749);
  });
});

describe('Reconciler — snapshot-before-stream ordering (CG-SM-4, §5.2 rule 4)', () => {
  it('queues live frames during reconnect and applies them after snapshot', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT);
    r.onReconnectRequested(); // awaitingSnapshot = true
    r.applyVehicleUpdate({ latitude: 50, longitude: 50, heading: 10 }); // queued
    // not applied yet — still showing pre-reconnect cached value
    expect(r.getView().vehicle?.latitude).toBe(37.7749);
    r.applySnapshot({ ...VALID_SNAPSHOT, latitude: 41, longitude: -71, heading: 1 });
    // snapshot applied, THEN queued frame replayed on top
    expect(r.getView().vehicle?.latitude).toBe(50);
    expect(r.getView().dataState.gps).toBe('ready');
  });

  it('idempotent reconnect: a fresh reconnect supersedes the queue (§5.2 rule 5)', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT);
    r.onReconnectRequested();
    r.applyVehicleUpdate({ latitude: 99, longitude: 99, heading: 9 }); // queued
    r.onReconnectRequested(); // supersedes — queue cleared
    r.applySnapshot({ ...VALID_SNAPSHOT, latitude: 41, longitude: -71, heading: 1 });
    expect(r.getView().vehicle?.latitude).toBe(41); // stale queued frame dropped
  });
});

describe('Reconciler — drive lifecycle (DR-1..DR-6)', () => {
  it('DR-1 idle→driving, DR-3 driving→ended, DR-5 ended→idle', () => {
    const r = new Reconciler();
    const events = collect(r);
    r.applyDriveStarted({ driveId: 'd1' });
    expect(r.getView().drive).toBe('driving');
    expect(r.getView().activeDriveId).toBe('d1');
    r.applyDriveEnded({ driveId: 'd1', distance: 5, duration: 600 });
    expect(r.getView().drive).toBe('ended');
    expect(r.getView().driveSummary?.distance).toBe(5);
    r.acknowledgeDrive();
    expect(r.getView().drive).toBe('idle');
    expect(r.getView().activeDriveId).toBeNull();
    const drives = events.filter((e) => e.kind === 'drive');
    expect(drives).toHaveLength(3);
  });

  it('DR-6 ended→driving when a new drive starts pre-ack', () => {
    const r = new Reconciler();
    r.applyDriveStarted({ driveId: 'd1' });
    r.applyDriveEnded({ driveId: 'd1' });
    r.applyDriveStarted({ driveId: 'd2' });
    expect(r.getView().drive).toBe('driving');
    expect(r.getView().activeDriveId).toBe('d2');
    expect(r.getView().driveSummary).toBeNull();
  });

  it('DR-4 disconnect during drive → idle', () => {
    const r = new Reconciler();
    r.applyDriveStarted({ driveId: 'd1' });
    r.onDisconnected();
    expect(r.getView().drive).toBe('idle');
    expect(r.getView().activeDriveId).toBeNull();
  });

  it('DR-2 vehicle_update with GPS while driving emits a logical drive event', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT);
    r.applyDriveStarted({ driveId: 'd1' });
    const events = collect(r);
    r.applyVehicleUpdate({ latitude: 38, longitude: -122, heading: 12 });
    expect(events.some((e) => e.kind === 'drive' && e.to === 'driving')).toBe(true);
  });

  it('drive_ended ignored when not driving (only DR-3 from driving)', () => {
    const r = new Reconciler();
    r.applyDriveEnded({ driveId: 'ghost' });
    expect(r.getView().drive).toBe('idle');
  });
});

describe('Reconciler — invariants', () => {
  it('uses no client-side timers (NFR-3.7)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('./reconciler.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/\bsetTimeout\b/);
    expect(src).not.toMatch(/\bsetInterval\b/);
    expect(src).not.toMatch(/\bsetImmediate\b/);
  });

  it('getView returns frozen, non-mutable snapshots', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT);
    const v = r.getView();
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.dataState)).toBe(true);
  });

  it('per-group independence: nav clear does not affect gps', () => {
    const r = new Reconciler();
    r.applySnapshot(VALID_SNAPSHOT);
    expect(r.getView().dataState.gps).toBe('ready');
    expect(r.getView().dataState.navigation).toBe('cleared');
  });

  it('unsubscribe stops delivery', () => {
    const r = new Reconciler();
    const seen: ChangeEvent[] = [];
    const off = r.subscribe((e) => seen.push(e));
    off();
    r.applySnapshot(VALID_SNAPSHOT);
    expect(seen).toHaveLength(0);
  });

  it('a throwing listener does not break others', () => {
    const r = new Reconciler();
    const ok: ChangeEvent[] = [];
    r.subscribe(() => {
      throw new Error('boom');
    });
    r.subscribe((e) => ok.push(e));
    r.applySnapshot(VALID_SNAPSHOT);
    expect(ok.length).toBeGreaterThan(0);
  });
});
