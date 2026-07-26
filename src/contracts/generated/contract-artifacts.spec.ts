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
    expect(etherdocContractArtifacts.networks.ethereumSepolia).toMatchObject({
      chainId: 11155111,
      chainSelector: '16015286601757825753',
      feeMode: 'LINK',
      gasLimit: 500000,
    });
    expect(etherdocContractArtifacts.networks.mantleSepolia).toMatchObject({
      chainId: 5003,
      chainSelector: '8236463271206331221',
      feeMode: 'LINK',
      gasLimit: 500000,
    });
  });

  it('exports the exact deployment manifests', () => {
    expect(etherdocContractArtifacts.deployments.sender).toMatchObject({
      address: '0xAab5e5dA0b2C6E89D64B188df4dB18D655D629e7',
      deploymentBlock: 11354109,
      network: 'ethereumSepolia',
      role: 'sender',
      runtimeCodeHash:
        '0x7fdd145e13ac74986afae4df105d091429fa4342b237df13133c6e6d2dcb339e',
      status: 'DEPLOYED',
    });
    expect(
      etherdocContractArtifacts.deployments.sender.manifest?.transactionHash,
    ).toBe(
      '0x3a24898943d7daccab82e3148e160bbaa19d4eb9811439634d77b11da66acfee',
    );
    expect(etherdocContractArtifacts.deployments.receiver).toMatchObject({
      address: '0xAab5e5dA0b2C6E89D64B188df4dB18D655D629e7',
      deploymentBlock: 41758817,
      network: 'mantleSepolia',
      role: 'receiver',
      runtimeCodeHash:
        '0xf6d7a933eb65676f6ec3bc6d6eb50307f58994649157f010a675646f2f518531',
      status: 'DEPLOYED',
    });
    expect(
      etherdocContractArtifacts.deployments.receiver.manifest?.transactionHash,
    ).toBe(
      '0x68c4cd2052ca66ae21d5b084ac197aee9f93619c42349cc931af2221f7913e9f',
    );
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
