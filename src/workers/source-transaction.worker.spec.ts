import { classifySourceFailure } from './source-transaction.worker';

describe('classifySourceFailure', () => {
  it.each([
    ['RPC connection refused', 'RETRYABLE'],
    ['request timed out', 'RETRYABLE'],
    ['RegistrationIsPaused()', 'RETRYABLE'],
    ['SignatureExpired(123)', 'TERMINAL'],
    ['InvalidIssuerSignature(0x01)', 'TERMINAL'],
    ['DocumentNotActive(0x01)', 'TERMINAL'],
    ['execution reverted', 'TERMINAL'],
  ] as const)('classifies %s as %s', (message, expected) => {
    expect(classifySourceFailure(new Error(message))).toBe(expected);
  });
});
