import {
  jsonTypedData,
  registerTypedData,
  revokeTypedData,
  supersedeTypedData,
  typedDataDigest,
} from './intent-typed-data';

const domain = {
  chainId: 5003,
  verifyingContract: '0x0000000000000000000000000000000000000001',
} as const;
const issuer = '0x0000000000000000000000000000000000000002';
const digest =
  '0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const otherDigest =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('intent typed data', () => {
  it('builds the exact Etherdoc v2 register shape', () => {
    const typedData = registerTypedData(domain, {
      cidCodec: 0x55,
      cidDigest: digest,
      contentDigest: digest,
      deadline: 2_000_000_000n,
      documentId: otherDigest,
      issuer,
      metadataCommitment: otherDigest,
      nonce: 7n,
    });

    expect(typedData.domain).toEqual({
      chainId: 5003,
      name: 'Etherdoc',
      verifyingContract: domain.verifyingContract,
      version: '2',
    });
    expect(typedData.primaryType).toBe('RegisterDocument');
    expect(typedDataDigest(typedData)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(jsonTypedData(typedData)).toMatchObject({
      message: { deadline: '2000000000', nonce: '7' },
    });
  });

  it('binds current version for revoke', () => {
    const base = revokeTypedData(domain, {
      currentVersion: 1n,
      deadline: 2_000_000_000n,
      documentId: digest,
      issuer,
      nonce: 8n,
    });
    const stale = revokeTypedData(domain, {
      ...base.message,
      currentVersion: 2n,
    });
    expect(typedDataDigest(base)).not.toBe(typedDataDigest(stale));
  });

  it('binds all replacement fields for supersede', () => {
    const base = supersedeTypedData(domain, {
      currentVersion: 1n,
      deadline: 2_000_000_000n,
      issuer,
      metadataCommitment: otherDigest,
      newCidCodec: 0x70,
      newCidDigest: otherDigest,
      newContentDigest: digest,
      newDocumentId: otherDigest,
      nonce: 9n,
      oldDocumentId: digest,
    });
    const changed = supersedeTypedData(domain, {
      ...base.message,
      newCidDigest: digest,
    });
    expect(typedDataDigest(base)).not.toBe(typedDataDigest(changed));
  });
});
