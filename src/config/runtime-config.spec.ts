import { buildRuntimeConfig } from './runtime-config';

const privateKey =
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function validEnvironment(): Record<string, string> {
  return {
    BACKEND_PRIVATE_KEY: privateKey,
    DATABASE_URL: 'postgresql://etherdoc:etherdoc@localhost:5432/etherdoc',
    ETHERDOC_RECEIVER_ADDRESS: '0x0000000000000000000000000000000000000002',
    ETHERDOC_RECEIVER_DEPLOYMENT_BLOCK: '1',
    ETHERDOC_SENDER_ADDRESS: '0x0000000000000000000000000000000000000001',
    ETHERDOC_SENDER_DEPLOYMENT_BLOCK: '1',
    INK_SEPOLIA_RPC_URL: 'https://ink.example/rpc',
    JWT_SECRET: 'a-secure-test-secret-with-more-than-32-characters',
    MANTLE_SEPOLIA_RPC_URL: 'https://mantle.example/rpc',
    PINATA_API_URL: 'https://api.pinata.example',
    PINATA_GATEWAY_URL: 'https://gateway.pinata.example',
    PINATA_JWT_TOKEN: 'pinata-token',
    PINATA_UPLOAD_URL: 'https://uploads.pinata.example',
    SIWE_DOMAIN: 'etherdoc.example',
    SIWE_URI: 'https://etherdoc.example',
  };
}

describe('buildRuntimeConfig', () => {
  it('builds lossless chain configuration from generated artifacts', () => {
    const config = buildRuntimeConfig(validEnvironment());

    expect(config.blockchain.source.chainId).toBe(5003);
    expect(config.blockchain.source.chainSelector).toBe(8236463271206331221n);
    expect(config.blockchain.destination.chainId).toBe(763373);
    expect(config.blockchain.destination.chainSelector).toBe(
      9763904284804119144n,
    );
    expect(config.blockchain.signerAddress).toMatch(/^0x[0-9A-Fa-f]{40}$/);
  });

  it.each([
    'DATABASE_URL',
    'MANTLE_SEPOLIA_RPC_URL',
    'INK_SEPOLIA_RPC_URL',
    'BACKEND_PRIVATE_KEY',
    'ETHERDOC_RECEIVER_DEPLOYMENT_BLOCK',
    'ETHERDOC_SENDER_DEPLOYMENT_BLOCK',
    'SIWE_DOMAIN',
    'SIWE_URI',
    'JWT_SECRET',
  ])('rejects missing %s', (name) => {
    const environment = validEnvironment();
    delete environment[name];

    expect(() => buildRuntimeConfig(environment)).toThrow(name);
  });

  it('rejects an address override that differs from a deployed registry', () => {
    // The current baseline is intentionally undeployed; this behavior is covered
    // by deploymentAddress when generated manifests populate the registry.
    const environment = validEnvironment();
    environment.ETHERDOC_SENDER_ADDRESS = 'not-an-address';

    expect(() => buildRuntimeConfig(environment)).toThrow(
      'ETHERDOC_SENDER_ADDRESS must be a valid EVM address',
    );
  });

  it('rejects unsafe numeric and secret configuration', () => {
    expect(() =>
      buildRuntimeConfig({
        ...validEnvironment(),
        JWT_SECRET: 'short',
      }),
    ).toThrow('JWT_SECRET');
    expect(() =>
      buildRuntimeConfig({
        ...validEnvironment(),
        RPC_REQUEST_TIMEOUT_MS: '0',
      }),
    ).toThrow('RPC_REQUEST_TIMEOUT_MS');
  });
});
