import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { etherdocContractArtifacts } from '../contracts/generated';

export interface ChainRuntimeConfig {
  chainId: number;
  chainSelector: bigint;
  confirmations: number;
  contractAddress: Address;
  deploymentBlock: bigint;
  explorerUrl: string;
  linkToken: Address;
  name: string;
  rpcUrl: string;
  router: Address;
}

export type OutboxJobType =
  | 'CONFIRM_SOURCE'
  | 'DISPATCH_DESTINATION'
  | 'RECONCILE'
  | 'SUBMIT_SOURCE'
  | 'TRACK_DESTINATION';

export interface RuntimeConfig {
  auth: {
    nonceCleanupBatchSize: number;
    nonceCleanupIntervalSeconds: number;
    nonceRetentionSeconds: number;
  };
  blockchain: {
    destination: ChainRuntimeConfig;
    requestTimeoutMs: number;
    signerAddress: Address;
    signerPrivateKey: Hex;
    source: ChainRuntimeConfig;
  };
  corsOrigin: string;
  databaseUrl: string;
  dispatch: {
    feeBufferBps: number;
    maximumFeeWei: bigint;
    recoveryAfterSeconds: number;
  };
  jwt: {
    secret: string;
  };
  intent: {
    signatureTtlSeconds: number;
  };
  http: {
    cookieSecure: boolean;
    replicaCount: number;
    trustProxyHops: number;
  };
  health: {
    readinessCacheMs: number;
  };
  pinata: {
    apiUrl: string;
    gatewayUrl: string;
    jwt: string;
    uploadUrl: string;
  };
  port: number;
  rateLimit: {
    apiLimit: number;
    authLimit: number;
    searchLimit: number;
    uploadLimit: number;
    windowMs: number;
  };
  siwe: {
    domain: string;
    nonceTtlSeconds: number;
    sessionTtlSeconds: number;
    uri: string;
  };
  worker: {
    batchSize: number;
    drainTimeoutMs: number;
    heartbeatIntervalMs: number;
    indexBlockRange: number;
    indexIntervalMs: number;
    lockTimeoutMs: number;
    maxAttempts: Record<OutboxJobType, number>;
    pollIntervalMs: number;
  };
}

type Environment = Record<string, string | undefined>;

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function url(environment: Environment, name: string): string {
  const value = required(environment, name);
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
}

function integer(
  environment: Environment,
  name: string,
  defaultValue: number,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = environment[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function boolean(environment: Environment, name: string): boolean {
  const value = required(environment, name).toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be either true or false`);
}

function httpOrigin(
  environment: Environment,
  name: string,
  defaultValue: string,
): string {
  const value = environment[name]?.trim() || defaultValue;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP origin`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be a valid HTTP origin without a path`);
  }
  return parsed.origin;
}

function address(value: string, name: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${name} must be a valid EVM address`);
  }
}

function deploymentAddress(
  environment: Environment,
  environmentName: string,
  registryAddress: string | null,
): Address {
  const override = environment[environmentName]?.trim();
  if (!registryAddress && !override) {
    throw new Error(
      `${environmentName} is required until the smart contract deployment manifest exists`,
    );
  }
  if (
    registryAddress &&
    override &&
    registryAddress.toLowerCase() !== override.toLowerCase()
  ) {
    throw new Error(
      `${environmentName} does not match the generated deployment registry`,
    );
  }
  return address(registryAddress ?? override!, environmentName);
}

function deploymentBlock(
  environment: Environment,
  environmentName: string,
  registryBlock: number | null,
): bigint {
  if (registryBlock !== null) {
    return BigInt(registryBlock);
  }
  return unsignedBigInt(environment, environmentName, '');
}

function privateKey(environment: Environment): Hex {
  const value = required(environment, 'BACKEND_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      'BACKEND_PRIVATE_KEY must be a 32-byte 0x-prefixed hex value',
    );
  }
  return value as Hex;
}

function postgresUrl(environment: Environment): string {
  const value = required(environment, 'DATABASE_URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql scheme');
  }
  return value;
}

function unsignedBigInt(
  environment: Environment,
  name: string,
  defaultValue: string,
): bigint {
  const value = environment[name]?.trim() || defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an unsigned decimal integer`);
  }
  return BigInt(value);
}

export function buildRuntimeConfig(
  environment: Environment = process.env,
): RuntimeConfig {
  const signerPrivateKey = privateKey(environment);
  const signerAddress = privateKeyToAccount(signerPrivateKey).address;
  const sourceNetwork = etherdocContractArtifacts.networks.ethereumSepolia;
  const destinationNetwork = etherdocContractArtifacts.networks.mantleSepolia;

  const jwtSecret = required(environment, 'JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters');
  }

  const siweDomain = required(environment, 'SIWE_DOMAIN');
  if (
    siweDomain.includes('://') ||
    siweDomain.includes('/') ||
    siweDomain.trim() !== siweDomain
  ) {
    throw new Error('SIWE_DOMAIN must be a hostname without scheme or path');
  }
  const replicaCount = integer(environment, 'API_REPLICA_COUNT', 1);
  if (replicaCount !== 1) {
    throw new Error(
      'API_REPLICA_COUNT must remain 1 while rate limiting uses in-memory storage',
    );
  }
  const outboxLockTimeoutMs = integer(
    environment,
    'OUTBOX_LOCK_TIMEOUT_MS',
    600_000,
    10_000,
  );
  const outboxHeartbeatIntervalMs = integer(
    environment,
    'OUTBOX_HEARTBEAT_INTERVAL_MS',
    30_000,
    1_000,
  );
  if (outboxHeartbeatIntervalMs >= outboxLockTimeoutMs) {
    throw new Error(
      'OUTBOX_HEARTBEAT_INTERVAL_MS must be less than OUTBOX_LOCK_TIMEOUT_MS',
    );
  }
  const defaultOutboxMaxAttempts = integer(
    environment,
    'OUTBOX_MAX_ATTEMPTS',
    8,
    1,
    100,
  );

  return {
    auth: {
      nonceCleanupBatchSize: integer(
        environment,
        'AUTH_NONCE_CLEANUP_BATCH_SIZE',
        500,
        1,
        10_000,
      ),
      nonceCleanupIntervalSeconds: integer(
        environment,
        'AUTH_NONCE_CLEANUP_INTERVAL_SECONDS',
        3_600,
        60,
      ),
      nonceRetentionSeconds: integer(
        environment,
        'AUTH_NONCE_RETENTION_SECONDS',
        604_800,
        3_600,
      ),
    },
    blockchain: {
      destination: {
        chainId: destinationNetwork.chainId,
        chainSelector: BigInt(destinationNetwork.chainSelector),
        confirmations: integer(environment, 'MANTLE_CONFIRMATION_DEPTH', 2, 0),
        contractAddress: deploymentAddress(
          environment,
          'ETHERDOC_RECEIVER_ADDRESS',
          etherdocContractArtifacts.deployments.receiver.address,
        ),
        deploymentBlock: deploymentBlock(
          environment,
          'ETHERDOC_RECEIVER_DEPLOYMENT_BLOCK',
          etherdocContractArtifacts.deployments.receiver.deploymentBlock,
        ),
        explorerUrl: destinationNetwork.explorer,
        linkToken: address(destinationNetwork.linkToken, 'Mantle LINK token'),
        name: 'Mantle Sepolia',
        router: address(destinationNetwork.router, 'Mantle CCIP router'),
        rpcUrl: url(environment, 'MANTLE_SEPOLIA_RPC_URL'),
      },
      requestTimeoutMs: integer(environment, 'RPC_REQUEST_TIMEOUT_MS', 15_000),
      signerAddress,
      signerPrivateKey,
      source: {
        chainId: sourceNetwork.chainId,
        chainSelector: BigInt(sourceNetwork.chainSelector),
        confirmations: integer(
          environment,
          'ETHEREUM_CONFIRMATION_DEPTH',
          2,
          0,
        ),
        contractAddress: deploymentAddress(
          environment,
          'ETHERDOC_SENDER_ADDRESS',
          etherdocContractArtifacts.deployments.sender.address,
        ),
        deploymentBlock: deploymentBlock(
          environment,
          'ETHERDOC_SENDER_DEPLOYMENT_BLOCK',
          etherdocContractArtifacts.deployments.sender.deploymentBlock,
        ),
        explorerUrl: sourceNetwork.explorer,
        linkToken: address(sourceNetwork.linkToken, 'Ethereum LINK token'),
        name: 'Ethereum Sepolia',
        router: address(sourceNetwork.router, 'Ethereum CCIP router'),
        rpcUrl: url(environment, 'ETHEREUM_SEPOLIA_RPC_URL'),
      },
    },
    corsOrigin: httpOrigin(environment, 'CORS_ORIGIN', 'http://localhost:3000'),
    databaseUrl: postgresUrl(environment),
    dispatch: {
      feeBufferBps: integer(
        environment,
        'DISPATCH_FEE_BUFFER_BPS',
        1_000,
        0,
        10_000,
      ),
      maximumFeeWei: unsignedBigInt(
        environment,
        'MAXIMUM_DISPATCH_FEE_WEI',
        '10000000000000000000',
      ),
      recoveryAfterSeconds: integer(
        environment,
        'CCIP_RECOVERY_AFTER_SECONDS',
        3600,
      ),
    },
    jwt: {
      secret: jwtSecret,
    },
    intent: {
      signatureTtlSeconds: integer(
        environment,
        'INTENT_SIGNATURE_TTL_SECONDS',
        600,
      ),
    },
    http: {
      cookieSecure: boolean(environment, 'COOKIE_SECURE'),
      replicaCount,
      trustProxyHops: integer(environment, 'TRUST_PROXY_HOPS', 0, 0, 10),
    },
    health: {
      readinessCacheMs: integer(
        environment,
        'HEALTH_READINESS_CACHE_MS',
        5_000,
        100,
        60_000,
      ),
    },
    pinata: {
      apiUrl: url(environment, 'PINATA_API_URL'),
      gatewayUrl: url(environment, 'PINATA_GATEWAY_URL'),
      jwt: required(environment, 'PINATA_JWT_TOKEN'),
      uploadUrl: url(environment, 'PINATA_UPLOAD_URL'),
    },
    port: integer(environment, 'PORT', 3000),
    rateLimit: {
      apiLimit: integer(environment, 'RATE_LIMIT_API_REQUESTS', 120),
      authLimit: integer(environment, 'RATE_LIMIT_AUTH_REQUESTS', 5),
      searchLimit: integer(environment, 'RATE_LIMIT_SEARCH_REQUESTS', 30),
      uploadLimit: integer(environment, 'RATE_LIMIT_UPLOAD_REQUESTS', 8),
      windowMs: integer(environment, 'RATE_LIMIT_WINDOW_MS', 60_000, 1_000),
    },
    siwe: {
      domain: siweDomain,
      nonceTtlSeconds: integer(environment, 'SIWE_NONCE_TTL_SECONDS', 300),
      sessionTtlSeconds: integer(environment, 'SIWE_SESSION_TTL_SECONDS', 900),
      uri: url(environment, 'SIWE_URI'),
    },
    worker: {
      batchSize: integer(environment, 'OUTBOX_BATCH_SIZE', 10),
      drainTimeoutMs: integer(
        environment,
        'WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS',
        30_000,
        1_000,
      ),
      heartbeatIntervalMs: outboxHeartbeatIntervalMs,
      indexBlockRange: integer(environment, 'CHAIN_INDEX_BLOCK_RANGE', 2_000),
      indexIntervalMs: integer(environment, 'CHAIN_INDEX_INTERVAL_MS', 15_000),
      lockTimeoutMs: outboxLockTimeoutMs,
      maxAttempts: {
        CONFIRM_SOURCE: integer(
          environment,
          'OUTBOX_MAX_ATTEMPTS_CONFIRM_SOURCE',
          defaultOutboxMaxAttempts,
          1,
          100,
        ),
        DISPATCH_DESTINATION: integer(
          environment,
          'OUTBOX_MAX_ATTEMPTS_DISPATCH_DESTINATION',
          defaultOutboxMaxAttempts,
          1,
          100,
        ),
        RECONCILE: integer(
          environment,
          'OUTBOX_MAX_ATTEMPTS_RECONCILE',
          defaultOutboxMaxAttempts,
          1,
          100,
        ),
        SUBMIT_SOURCE: integer(
          environment,
          'OUTBOX_MAX_ATTEMPTS_SUBMIT_SOURCE',
          defaultOutboxMaxAttempts,
          1,
          100,
        ),
        TRACK_DESTINATION: integer(
          environment,
          'OUTBOX_MAX_ATTEMPTS_TRACK_DESTINATION',
          defaultOutboxMaxAttempts,
          1,
          100,
        ),
      },
      pollIntervalMs: integer(environment, 'OUTBOX_POLL_INTERVAL_MS', 1_000),
    },
  };
}

export function loadRuntimeConfiguration(): { runtime: RuntimeConfig } {
  return { runtime: buildRuntimeConfig() };
}
