import {
  parsePinataMetadataResponse,
  parsePinataUploadResponse,
} from './pinata-response';

describe('Pinata response parsing', () => {
  it('parses upload identifiers without retaining unvalidated fields', () => {
    expect(
      parsePinataUploadResponse({
        data: { cid: 'bafy-test', id: 'provider-id', ignored: true },
      }),
    ).toEqual({
      data: { cid: 'bafy-test', id: 'provider-id' },
    });
  });

  it('rejects malformed upload fields', () => {
    expect(() => parsePinataUploadResponse({ data: { cid: 123 } })).toThrow(
      'Pinata upload response CID must be a string',
    );
  });

  it('requires metadata responses to have an object root', () => {
    expect(parsePinataMetadataResponse({ data: { groups: [] } })).toEqual({
      data: { groups: [] },
    });
    expect(() => parsePinataMetadataResponse([])).toThrow(
      'Pinata metadata response must be an object',
    );
  });
});
