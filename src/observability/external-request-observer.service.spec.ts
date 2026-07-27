import { Logger } from '@nestjs/common';
import { CorrelationContextService } from './correlation-context.service';
import {
  classifyExternalFailure,
  ExternalRequestObserver,
} from './external-request-observer.service';

describe('ExternalRequestObserver', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('classifies common external failures', () => {
    expect(classifyExternalFailure(new Error('request timed out'))).toBe(
      'TIMEOUT',
    );
    expect(
      classifyExternalFailure(new Error('network connection failed')),
    ).toBe('NETWORK');
    expect(classifyExternalFailure(new Error('unexpected'))).toBe('UNKNOWN');
  });

  it('records safe correlation metadata without logging request URLs', async () => {
    const logger = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const correlation = new CorrelationContextService();
    const observer = new ExternalRequestObserver(correlation);

    await correlation.run('request-id', () =>
      observer.fetch(
        'rpc',
        'source',
        'https://user:secret@rpc.example/api-key',
      ),
    );

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: 'source',
        correlationId: 'request-id',
        dependency: 'rpc',
        event: 'external_request_completed',
        failureClassification: null,
        operation: 'source',
        outcome: 'success',
        statusCode: 204,
      }),
    );
    expect(JSON.stringify(logger.mock.calls)).not.toContain('rpc.example');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('api-key');
  });
});
