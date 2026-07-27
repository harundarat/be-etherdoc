import { boundedBackoffMilliseconds } from './database.service';

describe('boundedBackoffMilliseconds', () => {
  it('grows exponentially and remains bounded', () => {
    const noJitter = () => 0;
    expect(boundedBackoffMilliseconds(0, noJitter)).toBe(1_000);
    expect(boundedBackoffMilliseconds(1, noJitter)).toBe(2_000);
    expect(boundedBackoffMilliseconds(8, noJitter)).toBe(256_000);
    expect(boundedBackoffMilliseconds(100, noJitter)).toBe(300_000);
    expect(boundedBackoffMilliseconds(-1, noJitter)).toBe(1_000);
  });

  it('adds bounded jitter without exceeding the backoff ceiling', () => {
    expect(boundedBackoffMilliseconds(1, () => 1)).toBe(2_500);
    expect(boundedBackoffMilliseconds(8, () => 1)).toBe(300_000);
  });
});
