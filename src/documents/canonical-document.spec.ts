import {
  CID_CODEC_DAG_PB,
  CID_CODEC_RAW,
  CanonicalDocumentError,
  canonicalizeMetadata,
  computeDocumentId,
  encodeCanonicalCid,
  parseCanonicalCid,
  sha256Digest,
} from './canonical-document';

describe('canonical document primitives', () => {
  const helloDigest =
    '0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

  it('hashes the exact uploaded bytes', () => {
    expect(sha256Digest(Buffer.from('hello'))).toBe(helloDigest);
    expect(sha256Digest(Buffer.from('hello!'))).not.toBe(helloDigest);
  });

  it.each([CID_CODEC_RAW, CID_CODEC_DAG_PB] as const)(
    'round-trips canonical CID codec %d',
    (codec) => {
      const cid = encodeCanonicalCid(codec, helloDigest);
      expect(cid).toHaveLength(59);
      expect(parseCanonicalCid(cid, helloDigest)).toEqual({
        cid,
        cidCodec: codec,
        cidDigest: helloDigest,
      });
    },
  );

  it('rejects non-canonical CID text and raw digest mismatch', () => {
    const cid = encodeCanonicalCid(CID_CODEC_RAW, helloDigest);
    expect(() => parseCanonicalCid(cid.toUpperCase(), helloDigest)).toThrow(
      CanonicalDocumentError,
    );
    expect(() =>
      parseCanonicalCid(cid, sha256Digest(Buffer.from('different'))),
    ).toThrow('Raw CID digest does not match');
  });

  it('canonicalizes approved non-PII metadata deterministically', () => {
    const first = canonicalizeMetadata({
      byteLength: 5,
      documentType: 'certificate',
      mimeType: 'APPLICATION/PDF',
      storageNetwork: 'private',
    });
    const second = canonicalizeMetadata({
      storageNetwork: 'private',
      mimeType: 'APPLICATION/PDF',
      documentType: 'certificate',
      byteLength: 5,
    });

    expect(first).toEqual(second);
    expect(first.json).toBe(
      '{"metadata":{"byteLength":5,"documentType":"certificate","mimeType":"application/pdf","storageNetwork":"private"},"schema":"etherdoc.metadata.v1"}',
    );
    expect(first.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(
      canonicalizeMetadata({
        ...first.preimage.metadata,
        byteLength: 6,
      }).commitment,
    ).not.toBe(first.commitment);
  });

  it('computes document identity from issuer and content digest', () => {
    const issuer = '0x0000000000000000000000000000000000000001';
    expect(computeDocumentId(issuer, helloDigest)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(
      computeDocumentId(
        '0x0000000000000000000000000000000000000002',
        helloDigest,
      ),
    ).not.toBe(computeDocumentId(issuer, helloDigest));
  });
});
