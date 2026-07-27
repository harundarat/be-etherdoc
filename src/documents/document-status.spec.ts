import {
  documentLifecycleStatus,
  requireDocumentLifecycleStatus,
} from './document-status';

describe('document lifecycle status parsing', () => {
  it.each([
    [1, 'ACTIVE'],
    [2, 'REVOKED'],
    [3, 'SUPERSEDED'],
  ] as const)('maps contract status %s', (value, expected) => {
    expect(documentLifecycleStatus(value)).toBe(expected);
  });

  it('rejects an unknown contract status', () => {
    expect(documentLifecycleStatus(0)).toBeNull();
    expect(() => requireDocumentLifecycleStatus(4)).toThrow(
      'Contract returned invalid document status 4',
    );
  });
});
