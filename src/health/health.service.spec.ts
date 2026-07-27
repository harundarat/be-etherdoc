import { ConfigService } from '@nestjs/config';
import type { RuntimeConfig } from '../config/runtime-config';
import type { DatabaseService } from '../database/database.service';
import { OperationalStateService } from '../observability/operational-state.service';
import { HealthService } from './health.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createService(
  readiness: jest.Mock = jest.fn().mockResolvedValue(true),
): {
  readiness: jest.Mock;
  service: HealthService;
  state: OperationalStateService;
} {
  const runtime = {
    health: { readinessCacheMs: 1_000 },
  } as RuntimeConfig;
  const state = new OperationalStateService();
  const service = new HealthService(
    new ConfigService({ runtime }),
    { readiness } as unknown as DatabaseService,
    state,
  );
  return { readiness, service, state };
}

describe('HealthService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports dependency-free liveness', () => {
    const { readiness, service } = createService();

    expect(service.live()).toMatchObject({ status: 'live' });
    expect(service.live().checkedAt).toEqual(expect.any(String));
    expect(readiness).not.toHaveBeenCalled();
  });

  it('distinguishes blockchain startup and a missing schema', async () => {
    const { readiness, service, state } = createService(
      jest.fn().mockResolvedValue(false),
    );

    await expect(service.ready()).resolves.toMatchObject({
      checks: {
        blockchainStartup: 'starting',
        database: 'ready',
        schema: 'missing',
      },
      status: 'degraded',
    });

    state.markBlockchainReady();
    await expect(service.ready()).resolves.toMatchObject({
      checks: {
        blockchainStartup: 'ready',
        database: 'ready',
        schema: 'missing',
      },
      status: 'degraded',
    });
    expect(readiness).toHaveBeenCalledTimes(1);
  });

  it('recovers after a failed database probe cache expires', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
    const readiness = jest
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(true);
    const { service, state } = createService(readiness);
    state.markBlockchainReady();

    await expect(service.ready()).resolves.toMatchObject({
      checks: { database: 'unavailable', schema: 'unknown' },
      status: 'degraded',
    });
    await expect(service.ready()).resolves.toMatchObject({
      checks: { database: 'unavailable', schema: 'unknown' },
      status: 'degraded',
    });
    expect(readiness).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_001);
    await expect(service.ready()).resolves.toMatchObject({
      checks: { database: 'ready', schema: 'ready' },
      status: 'ready',
    });
    expect(readiness).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent database probes', async () => {
    const probe = deferred<boolean>();
    const readiness = jest.fn().mockReturnValue(probe.promise);
    const { service, state } = createService(readiness);
    state.markBlockchainReady();

    const first = service.ready();
    const second = service.ready();
    expect(readiness).toHaveBeenCalledTimes(1);

    probe.resolve(true);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'ready' }),
      expect.objectContaining({ status: 'ready' }),
    ]);
  });

  it('skips dependencies once graceful shutdown begins', async () => {
    const { readiness, service, state } = createService();
    state.beforeApplicationShutdown('SIGTERM');

    await expect(service.ready()).resolves.toMatchObject({
      checks: {
        blockchainStartup: 'starting',
        database: 'not_checked',
        schema: 'not_checked',
      },
      status: 'shutting_down',
    });
    expect(readiness).not.toHaveBeenCalled();
  });
});
