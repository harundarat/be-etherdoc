import { normalizedIndexedLog } from './chain-indexer.service';

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
