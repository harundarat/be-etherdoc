import { missingNonceEvidenceDisposition } from './reconciliation.worker';

describe('missingNonceEvidenceDisposition', () => {
  it('waits while a reserved nonce may still be pending', () => {
    expect(missingNonceEvidenceDisposition(7n, 7n)).toBe('WAIT');
    expect(missingNonceEvidenceDisposition(6n, 7n)).toBe('WAIT');
  });

  it('requires manual recovery instead of resending a consumed nonce', () => {
    expect(missingNonceEvidenceDisposition(8n, 7n)).toBe('MANUAL_RECOVERY');
  });
});
