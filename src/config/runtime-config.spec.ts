import { buildRuntimeConfig } from './runtime-config';
import { etherdocContractArtifacts } from '../contracts/generated/contract-artifacts.generated';

const privateKey =
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function validEnvironment(): Record<string, string> {
  return {
    BACKEND_PRIVATE_KEY: privateKey,
    COOKIE_SECURE: 'true',
    DATABASE_URL: 'postgresql://etherdoc:etherdoc@localhost:5432/etherdoc',
    ETHEREUM_SEPOLIA_RPC_URL: 'https://ethereum.example/rpc',
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

    expect(config.blockchain.source.chainId).toBe(11155111);
    expect(config.blockchain.destination.chainSelector).toBe(
      8236463271206331221n,
    );
    expect(config.blockchain.source.chainSelector).toBe(16015286601757825753n);
    expect(config.blockchain.destination.chainId).toBe(5003);
    expect(config.blockchain.source.contractAddress).toBe(
      etherdocContractArtifacts.deployments.sender.address,
    );
    expect(config.blockchain.source.deploymentBlock).toBe(
      BigInt(etherdocContractArtifacts.deployments.sender.deploymentBlock),
    );
    expect(config.blockchain.destination.contractAddress).toBe(
      etherdocContractArtifacts.deployments.receiver.address,
    );
    expect(config.blockchain.destination.deploymentBlock).toBe(
      BigInt(etherdocContractArtifacts.deployments.receiver.deploymentBlock),
    );
    expect(config.blockchain.signerAddress).toMatch(/^0x[0-9A-Fa-f]{40}$/);
  });

  it.each([
    'DATABASE_URL',
    'ETHEREUM_SEPOLIA_RPC_URL',
    'MANTLE_SEPOLIA_RPC_URL',
    'BACKEND_PRIVATE_KEY',
    'SIWE_DOMAIN',
    'SIWE_URI',
    'JWT_SECRET',
    'COOKIE_SECURE',
  ])('rejects missing %s', (name) => {
    const environment = validEnvironment();
    delete environment[name];

    expect(() => buildRuntimeConfig(environment)).toThrow(name);
  });

  it('rejects an address override that differs from a deployed registry', () => {
    const environment = validEnvironment();
    environment.ETHERDOC_SENDER_ADDRESS =
      '0x0000000000000000000000000000000000000001';

    expect(() => buildRuntimeConfig(environment)).toThrow(
      'ETHERDOC_SENDER_ADDRESS does not match the generated deployment registry',
    );
  });

  it('accepts optional overrides that match the deployed registry', () => {
    const environment = validEnvironment();
    environment.ETHERDOC_SENDER_ADDRESS =
      etherdocContractArtifacts.deployments.sender.address;
    environment.ETHERDOC_RECEIVER_ADDRESS =
      etherdocContractArtifacts.deployments.receiver.address;

    expect(() => buildRuntimeConfig(environment)).not.toThrow();
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

  it('uses the numeric SIWE session TTL regardless of a legacy JWT duration', () => {
    const config = buildRuntimeConfig({
      ...validEnvironment(),
      JWT_EXPIRES_IN: '30d',
      SIWE_SESSION_TTL_SECONDS: '1200',
    });

    expect(config.siwe.sessionTtlSeconds).toBe(1200);
    expect(config.jwt).toEqual({
      secret: 'a-secure-test-secret-with-more-than-32-characters',
    });
  });

  it('bounds authentication nonce cleanup configuration', () => {
    const config = buildRuntimeConfig({
      ...validEnvironment(),
      AUTH_NONCE_CLEANUP_BATCH_SIZE: '1000',
      AUTH_NONCE_CLEANUP_INTERVAL_SECONDS: '300',
      AUTH_NONCE_RETENTION_SECONDS: '86400',
    });

    expect(config.auth).toEqual({
      nonceCleanupBatchSize: 1000,
      nonceCleanupIntervalSeconds: 300,
      nonceRetentionSeconds: 86400,
    });
    expect(() =>
      buildRuntimeConfig({
        ...validEnvironment(),
        AUTH_NONCE_CLEANUP_BATCH_SIZE: '10001',
      }),
    ).toThrow('AUTH_NONCE_CLEANUP_BATCH_SIZE');
  });

  it('bounds worker shutdown drain configuration', () => {
    expect(buildRuntimeConfig(validEnvironment()).worker.drainTimeoutMs).toBe(
      30_000,
    );
    expect(
      buildRuntimeConfig({
        ...validEnvironment(),
        WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS: '45000',
      }).worker.drainTimeoutMs,
    ).toBe(45_000);
    expect(() =>
      buildRuntimeConfig({
        ...validEnvironment(),
        WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS: '999',
      }),
    ).toThrow('WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS');
  });

  it('bounds the health readiness cache interval', () => {
    expect(buildRuntimeConfig(validEnvironment()).health).toEqual({
      readinessCacheMs: 5_000,
    });
    expect(() =>
      buildRuntimeConfig({
        ...validEnvironment(),
        HEALTH_READINESS_CACHE_MS: '60001',
      }),
    ).toThrow('HEALTH_READINESS_CACHE_MS');
  });

  it('configures heartbeat and retry limits below the lease timeout', () => {
    const config = buildRuntimeConfig({
      ...validEnvironment(),
      OUTBOX_HEARTBEAT_INTERVAL_MS: '5000',
      OUTBOX_LOCK_TIMEOUT_MS: '20000',
      OUTBOX_MAX_ATTEMPTS: '6',
      OUTBOX_MAX_ATTEMPTS_TRACK_DESTINATION: '20',
    });

    expect(config.worker.heartbeatIntervalMs).toBe(5_000);
    expect(config.worker.maxAttempts).toEqual({
      CONFIRM_SOURCE: 6,
      DISPATCH_DESTINATION: 6,
      RECONCILE: 6,
      SUBMIT_SOURCE: 6,
      TRACK_DESTINATION: 20,
    });
    expect(() =>
      buildRuntimeConfig({
        ...validEnvironment(),
        OUTBOX_HEARTBEAT_INTERVAL_MS: '10000',
        OUTBOX_LOCK_TIMEOUT_MS: '10000',
      }),
    ).toThrow('OUTBOX_HEARTBEAT_INTERVAL_MS');
  });

  it('requires an explicit cookie security mode and one in-memory-limited replica', () => {
    expect(buildRuntimeConfig(validEnvironment()).http).toEqual({
      cookieSecure: true,
      replicaCount: 1,
      trustProxyHops: 0,
    });
    expect(() =>
      buildRuntimeConfig({
        ...validEnvironment(),
        COOKIE_SECURE: 'sometimes',
      }),
    ).toThrow('COOKIE_SECURE');
    expect(() =>
      buildRuntimeConfig({
        ...validEnvironment(),
        API_REPLICA_COUNT: '2',
      }),
    ).toThrow('in-memory storage');
  });

  it('accepts only a CORS origin without path, query, or fragment', () => {
    expect(
      buildRuntimeConfig({
        ...validEnvironment(),
        CORS_ORIGIN: 'https://app.etherdoc.example/',
      }).corsOrigin,
    ).toBe('https://app.etherdoc.example');
    expect(() =>
      buildRuntimeConfig({
        ...validEnvironment(),
        CORS_ORIGIN: 'https://app.etherdoc.example/path',
      }),
    ).toThrow('CORS_ORIGIN');
  });
});
