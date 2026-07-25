import { etherdocContractArtifacts } from './contract-artifacts.generated';

describe('generated contract artifacts', () => {
  it('pins the exact contract provenance and protocol versions', () => {
    expect(etherdocContractArtifacts.contractCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(etherdocContractArtifacts.compiler).toEqual({
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 200 },
      version: '0.8.36+commit.8a079791',
    });
    expect(etherdocContractArtifacts.protocol).toMatchObject({
      canonicalCidLength: 59,
      cid: {
        codecs: { dagPb: 0x70, raw: 0x55 },
        multihash: 'sha2-256',
        version: 1,
      },
      eip712Domain: { name: 'Etherdoc', version: '2' },
      payloadLength: 448,
      payloadSchemaVersion: 3,
    });
    expect(etherdocContractArtifacts.provenance.contentChecksum).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it('exports the canonical source and destination network', () => {
    expect(etherdocContractArtifacts.networks.mantleSepolia).toMatchObject({
      chainId: 5003,
      chainSelector: '8236463271206331221',
      feeMode: 'LINK',
      gasLimit: 500000,
    });
    expect(etherdocContractArtifacts.networks.inkSepolia).toMatchObject({
      chainId: 763373,
      chainSelector: '9763904284804119144',
      feeMode: 'LINK',
      gasLimit: 500000,
    });
  });

  it('does not invent deployment addresses before manifests exist', () => {
    expect(etherdocContractArtifacts.deployments.sender).toMatchObject({
      address: null,
      network: 'mantleSepolia',
      role: 'sender',
      status: 'UNDEPLOYED',
    });
    expect(etherdocContractArtifacts.deployments.receiver).toMatchObject({
      address: null,
      network: 'inkSepolia',
      role: 'receiver',
      status: 'UNDEPLOYED',
    });
  });

  it('contains the current lifecycle API and excludes legacy functions', () => {
    const senderFunctions = etherdocContractArtifacts.contracts.sender.abi
      .filter((item) => item.type === 'function')
      .map((item) => ('name' in item ? item.name : null));
    const receiverFunctions = etherdocContractArtifacts.contracts.receiver.abi
      .filter((item) => item.type === 'function')
      .map((item) => ('name' in item ? item.name : null));

    expect(senderFunctions).toEqual(
      expect.arrayContaining([
        'registerDocumentBySig',
        'revokeDocumentBySig',
        'supersedeDocumentBySig',
        'dispatchDocument',
        'verifyDocument',
      ]),
    );
    expect(senderFunctions).not.toContain('addDocument');
    expect(senderFunctions).not.toContain('documentExists');
    expect(receiverFunctions).toEqual(
      expect.arrayContaining([
        'getProcessedMessage',
        'getReceipt',
        'isTrustedRemote',
        'verifyDocument',
      ]),
    );
    expect(receiverFunctions).not.toContain('documentExists');
  });
});
