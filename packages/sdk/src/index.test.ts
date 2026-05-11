import { describe, expect, it } from 'vitest';

import { SDK_VERSION } from './index';

describe('@myrobotaxi/sdk scaffold', () => {
  it('exports a SDK_VERSION constant', () => {
    expect(typeof SDK_VERSION).toBe('string');
  });

  it('starts at v0.0.0 until MYR-50 lands the WS client', () => {
    expect(SDK_VERSION).toBe('0.0.0');
  });
});
