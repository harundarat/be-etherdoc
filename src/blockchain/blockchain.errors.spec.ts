import {
  BlockchainClientError,
  BlockchainErrorKind,
  classifyBlockchainError,
} from './blockchain.errors';

describe('classifyBlockchainError', () => {
  it.each([
    ['request timed out', BlockchainErrorKind.TIMEOUT],
    ['RPC connection refused', BlockchainErrorKind.RPC_UNAVAILABLE],
    ['execution reverted: paused', BlockchainErrorKind.CONTRACT_REVERT],
    ['chain id mismatch', BlockchainErrorKind.CHAIN_MISMATCH],
    ['unexpected failure', BlockchainErrorKind.UNKNOWN],
  ])('classifies %s', (message, expected) => {
    expect(classifyBlockchainError(new Error(message)).kind).toBe(expected);
  });

  it('does not wrap an already classified error', () => {
    const error = new BlockchainClientError(
      BlockchainErrorKind.NOT_FOUND,
      'missing',
    );
    expect(classifyBlockchainError(error)).toBe(error);
  });
});
