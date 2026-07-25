import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { etherdocContractArtifacts } from '../contracts/generated';

export interface ChainRuntimeConfig {
  chainId: number;
  chainSelector: bigint;
  confirmations: number;
  contractAddress: Address;
  explorerUrl: string;
  linkToken: Address;
  name: string;
  rpcUrl: string;
  router: Address;
}

export interface RuntimeConfig {
  blockchain: {
    destination: ChainRuntimeConfig;
    requestTimeoutMs: number;
    signerAddress: Address;
    signerPrivateKey: Hex;
    source: ChainRuntimeConfig;
  };
  corsOrigin: string;
  databaseUrl: string;
  jwt: {
    expiresIn: string;
    secret: string;
  };
  pinata: {
    apiUrl: string;
    gatewayUrl: string;
    jwt: string;
    uploadUrl: string;
  };
  port: number;
  siwe: {
    domain: string;
    nonceTtlSeconds: number;
    sessionTtlSeconds: number;
    uri: string;
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
): number {
  const raw = environment[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
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

function privateKey(environment: Environment): Hex {
  const value = required(environment, 'BACKEND_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('BACKEND_PRIVATE_KEY must be a 32-byte 0x-prefixed hex value');
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

export function buildRuntimeConfig(
  environment: Environment = process.env,
): RuntimeConfig {
  const signerPrivateKey = privateKey(environment);
  const signerAddress = privateKeyToAccount(signerPrivateKey).address;
  const sourceNetwork = etherdocContractArtifacts.networks.mantleSepolia;
  const destinationNetwork = etherdocContractArtifacts.networks.inkSepolia;

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

  return {
    blockchain: {
      destination: {
        chainId: destinationNetwork.chainId,
        chainSelector: BigInt(destinationNetwork.chainSelector),
        confirmations: integer(
          environment,
          'INK_CONFIRMATION_DEPTH',
          2,
          0,
        ),
        contractAddress: deploymentAddress(
          environment,
          'ETHERDOC_RECEIVER_ADDRESS',
          etherdocContractArtifacts.deployments.receiver.address,
        ),
        explorerUrl: destinationNetwork.explorer,
        linkToken: address(destinationNetwork.linkToken, 'Ink LINK token'),
        name: 'Ink Sepolia',
        router: address(destinationNetwork.router, 'Ink CCIP router'),
        rpcUrl: url(environment, 'INK_SEPOLIA_RPC_URL'),
      },
      requestTimeoutMs: integer(environment, 'RPC_REQUEST_TIMEOUT_MS', 15_000),
      signerAddress,
      signerPrivateKey,
      source: {
        chainId: sourceNetwork.chainId,
        chainSelector: BigInt(sourceNetwork.chainSelector),
        confirmations: integer(
          environment,
          'MANTLE_CONFIRMATION_DEPTH',
          2,
          0,
        ),
        contractAddress: deploymentAddress(
          environment,
          'ETHERDOC_SENDER_ADDRESS',
          etherdocContractArtifacts.deployments.sender.address,
        ),
        explorerUrl: sourceNetwork.explorer,
        linkToken: address(sourceNetwork.linkToken, 'Mantle LINK token'),
        name: 'Mantle Sepolia',
        router: address(sourceNetwork.router, 'Mantle CCIP router'),
        rpcUrl: url(environment, 'MANTLE_SEPOLIA_RPC_URL'),
      },
    },
    corsOrigin: environment.CORS_ORIGIN?.trim() || 'http://localhost:3000',
    databaseUrl: postgresUrl(environment),
    jwt: {
      expiresIn: environment.JWT_EXPIRES_IN?.trim() || '15m',
      secret: jwtSecret,
    },
    pinata: {
      apiUrl: url(environment, 'PINATA_API_URL'),
      gatewayUrl: url(environment, 'PINATA_GATEWAY_URL'),
      jwt: required(environment, 'PINATA_JWT_TOKEN'),
      uploadUrl: url(environment, 'PINATA_UPLOAD_URL'),
    },
    port: integer(environment, 'PORT', 3000),
    siwe: {
      domain: siweDomain,
      nonceTtlSeconds: integer(environment, 'SIWE_NONCE_TTL_SECONDS', 300),
      sessionTtlSeconds: integer(
        environment,
        'SIWE_SESSION_TTL_SECONDS',
        900,
      ),
      uri: url(environment, 'SIWE_URI'),
    },
  };
}

export function loadRuntimeConfiguration(): { runtime: RuntimeConfig } {
  return { runtime: buildRuntimeConfig() };
}
