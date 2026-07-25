import { bufferedMaximumFee, classifyDispatchFailure } from './dispatch.worker';

describe('bufferedMaximumFee', () => {
  it('adds a ceiling-rounded bounded quote buffer', () => {
    expect(bufferedMaximumFee(100n, 1_000, 1_000n)).toBe(110n);
    expect(bufferedMaximumFee(101n, 1_000, 1_000n)).toBe(112n);
    expect(bufferedMaximumFee(950n, 1_000, 1_000n)).toBe(1_000n);
  });

  it('rejects a quote above policy instead of underpaying', () => {
    expect(() => bufferedMaximumFee(1_001n, 1_000, 1_000n)).toThrow(
      'exceeds policy maximum',
    );
  });
});

describe('classifyDispatchFailure', () => {
  it.each([
    ['RPC connection refused', 'RETRYABLE'],
    ['DispatchIsPaused()', 'RETRYABLE'],
    ['NotEnoughBalance(0, 10)', 'RETRYABLE'],
    ['FeeExceedsMaximum(11, 10)', 'RETRYABLE'],
    ['UnauthorizedRole(0x01)', 'RECOVERY_REQUIRED'],
    ['DocumentAlreadyDispatched(0x01)', 'RECOVERY_REQUIRED'],
  ] as const)('classifies %s as %s', (message, expected) => {
    expect(classifyDispatchFailure(new Error(message))).toBe(expected);
  });
});
