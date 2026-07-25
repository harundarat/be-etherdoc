import {
  cursorRequiresRebuild,
  normalizedIndexedLog,
} from './chain-indexer.service';

describe('normalizedIndexedLog', () => {
  it('keeps lossless finalized log evidence', () => {
    const log = normalizedIndexedLog('MessageSent', {
      args: { destinationChainSelector: 9_763_904_284_804_119_144n },
      blockHash: `0x${'11'.repeat(32)}`,
      blockNumber: 42n,
      logIndex: 3,
      transactionHash: `0x${'22'.repeat(32)}`,
    });

    expect(log).toEqual({
      args: { destinationChainSelector: 9_763_904_284_804_119_144n },
      blockHash: `0x${'11'.repeat(32)}`,
      blockNumber: 42n,
      eventName: 'MessageSent',
      logIndex: 3,
      transactionHash: `0x${'22'.repeat(32)}`,
    });
  });

  it('rejects logs without complete canonical block identity', () => {
    expect(
      normalizedIndexedLog('MessageReceived', {
        args: {},
        blockHash: null,
        blockNumber: 42n,
        logIndex: 3,
        transactionHash: `0x${'22'.repeat(32)}`,
      }),
    ).toBeNull();
  });
});

describe('cursorRequiresRebuild', () => {
  const storedHash = `0x${'11'.repeat(32)}` as const;

  it('keeps a cursor only while its finalized block hash remains canonical', () => {
    expect(cursorRequiresRebuild(42n, storedHash, 50n, storedHash)).toBe(false);
    expect(
      cursorRequiresRebuild(42n, storedHash, 50n, `0x${'22'.repeat(32)}`),
    ).toBe(true);
    expect(cursorRequiresRebuild(42n, storedHash, 41n, storedHash)).toBe(true);
  });
});
