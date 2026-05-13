import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleLogger } from './logger';

describe('ConsoleLogger — defaults from NODE_ENV', () => {
  const originalEnv = globalThis.process?.env?.NODE_ENV;
  let debug: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    debug.mockRestore();
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    if (globalThis.process?.env) globalThis.process.env.NODE_ENV = originalEnv;
  });

  it('is silent in production', () => {
    if (globalThis.process?.env) globalThis.process.env.NODE_ENV = 'production';
    const logger = new ConsoleLogger();
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('logs at debug level when NODE_ENV is not production', () => {
    if (globalThis.process?.env) globalThis.process.env.NODE_ENV = 'development';
    const logger = new ConsoleLogger();
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(debug).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('ConsoleLogger — explicit level option', () => {
  let debug: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    debug.mockRestore();
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it('level: silent suppresses everything', () => {
    const logger = new ConsoleLogger({ level: 'silent' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('level: warn suppresses debug + info, allows warn + error', () => {
    const logger = new ConsoleLogger({ level: 'warn' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('forwards message + meta to console', () => {
    const logger = new ConsoleLogger({ level: 'debug' });
    logger.info('hello', { vehicleId: 'clxyz' });
    expect(info).toHaveBeenCalledWith('hello', { vehicleId: 'clxyz' });
  });
});
