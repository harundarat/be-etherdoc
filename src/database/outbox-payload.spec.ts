import { parseOutboxPayload } from './outbox-payload';

describe('outbox payload parsing', () => {
  it('keeps only validated job fields', () => {
    expect(
      parseOutboxPayload('SUBMIT_SOURCE', {
        correlationId: 'request-id',
        intentId: 'intent-id',
        ignored: 'value',
      }),
    ).toEqual({
      correlationId: 'request-id',
      dispatchId: undefined,
      intentId: 'intent-id',
      transactionId: undefined,
    });
  });

  it('records invalid payloads for terminal worker handling', () => {
    expect(parseOutboxPayload('TRACK_DESTINATION', null)).toEqual({
      invalidReason: 'payload must be an object',
    });
    expect(parseOutboxPayload('RECONCILE', { intentId: 'intent-id' })).toEqual({
      invalidReason:
        'RECONCILE requires dispatchId or intentId with transactionId',
    });
  });
});
