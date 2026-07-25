import { boundedBackoffMilliseconds } from './database.service';

describe('boundedBackoffMilliseconds', () => {
  it('grows exponentially and remains bounded', () => {
    expect(boundedBackoffMilliseconds(0)).toBe(1_000);
    expect(boundedBackoffMilliseconds(1)).toBe(2_000);
    expect(boundedBackoffMilliseconds(8)).toBe(256_000);
    expect(boundedBackoffMilliseconds(100)).toBe(300_000);
    expect(boundedBackoffMilliseconds(-1)).toBe(1_000);
  });
});
