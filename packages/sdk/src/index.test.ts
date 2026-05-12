import { describe, expect, it, expectTypeOf } from 'vitest';

import { SDK_VERSION } from './index';
import type { VehicleState, WebSocketEnvelope } from './types';

describe('@myrobotaxi/sdk scaffold', () => {
  it('exports a SDK_VERSION constant', () => {
    expect(typeof SDK_VERSION).toBe('string');
  });

  it('starts at v0.0.1 — MYR-49 consumes @myrobotaxi/contracts/types', () => {
    expect(SDK_VERSION).toBe('0.0.1');
  });
});

describe('@myrobotaxi/sdk/types', () => {
  it('re-exports VehicleState from @myrobotaxi/contracts', () => {
    const fixture = {
      vehicleId: 'clxyz1234567890abcdef',
      name: 'Optimus',
      status: 'parked',
      chargeLevel: 75,
    } as VehicleState;
    expectTypeOf(fixture.vehicleId).toEqualTypeOf<string>();
    expectTypeOf(fixture.chargeLevel).toEqualTypeOf<number>();
    expect(fixture.vehicleId).toBe('clxyz1234567890abcdef');
  });

  it('re-exports WebSocketEnvelope with discriminator', () => {
    const env = { type: 'heartbeat', payload: {} } as WebSocketEnvelope;
    expect(env.type).toBe('heartbeat');
  });
});
