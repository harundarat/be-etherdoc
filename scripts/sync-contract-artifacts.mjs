#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(scriptDirectory, '..');
const argumentsList = process.argv.slice(2);
const checkOnly = argumentsList.includes('--check');
const contractsDirectoryArgument = argumentsList.find((argument) =>
  argument.startsWith('--contracts-dir='),
);
const contractsRoot = resolve(
  contractsDirectoryArgument?.slice('--contracts-dir='.length) ??
    process.env.ETHERDOC_CONTRACTS_DIR ??
    resolve(backendRoot, '..', 'sc-etherdoc'),
);
const outputPath = resolve(
  backendRoot,
  'src/contracts/generated/contract-artifacts.generated.ts',
);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readText(relativePath) {
  const absolutePath = resolve(contractsRoot, relativePath);
  if (!existsSync(absolutePath)) {
    fail(
      `Missing smart contract input ${absolutePath}. Run forge build in sc-etherdoc first.`,
    );
  }
  return readFileSync(absolutePath, 'utf8');
}

function readJson(relativePath) {
  try {
    return JSON.parse(readText(relativePath));
  } catch (error) {
    fail(`Invalid JSON in ${relativePath}: ${error.message}`);
  }
}

function parseNetworkConfig(source) {
  const losslessSource = source.replace(
    /("chainSelector"\s*:\s*)(\d+)/g,
    '$1"$2"',
  );
  try {
    return JSON.parse(losslessSource);
  } catch (error) {
    fail(`Invalid network configuration: ${error.message}`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function extractNumber(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) {
    fail(`Unable to extract ${label} from Solidity source`);
  }
  return Number(match[1]);
}

function extractHexNumber(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) {
    fail(`Unable to extract ${label} from Solidity source`);
  }
  return Number.parseInt(match[1], 16);
}

function extractDomain(source) {
  const match = source.match(/EIP712\("([^"]+)",\s*"([^"]+)"\)/);
  if (!match) {
    fail('Unable to extract the EIP-712 domain from EtherdocSender.sol');
  }
  return { name: match[1], version: match[2] };
}

function getCommit() {
  try {
    return execFileSync('git', ['-C', contractsRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    fail(`${contractsRoot} is not a readable Git worktree`);
  }
}

function getDeployment(networkName, role, network, contractCommit) {
  const addressRelativePath = `deployments/testnet/${networkName}.json`;
  const manifestRelativePath = `deployments/testnet/manifests/${networkName}-${role}.json`;
  const hasAddressRegistry = existsSync(
    resolve(contractsRoot, addressRelativePath),
  );
  const hasManifest = existsSync(resolve(contractsRoot, manifestRelativePath));

  if (!hasAddressRegistry && !hasManifest) {
    return {
      address: null,
      chainId: network.chainId,
      chainSelector: network.chainSelector,
      deploymentBlock: null,
      manifest: null,
      network: networkName,
      role,
      runtimeCodeHash: null,
      status: 'UNDEPLOYED',
    };
  }
  if (!hasAddressRegistry || !hasManifest) {
    fail(
      `Incomplete ${networkName}/${role} deployment: address registry and manifest must both exist`,
    );
  }

  const addressRegistry = readJson(addressRelativePath);
  const manifest = readJson(manifestRelativePath);
  const address = addressRegistry[role];
  if (
    typeof address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(address) ||
    address.toLowerCase() !== String(manifest.address).toLowerCase()
  ) {
    fail(`Deployment address mismatch for ${networkName}/${role}`);
  }
  if (
    manifest.network !== networkName ||
    manifest.role !== role ||
    manifest.chainId !== network.chainId ||
    manifest.chainSelector !== network.chainSelector
  ) {
    fail(`Deployment manifest network mismatch for ${networkName}/${role}`);
  }
  if (
    manifest.source?.gitCommit !== contractCommit ||
    manifest.source?.gitDirty !== false
  ) {
    fail(
      `Deployment manifest for ${networkName}/${role} is not tied to clean commit ${contractCommit}`,
    );
  }
  if (
    typeof manifest.runtimeCodeHash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(manifest.runtimeCodeHash)
  ) {
    fail(`Invalid runtime code hash for ${networkName}/${role}`);
  }

  return {
    address,
    chainId: manifest.chainId,
    chainSelector: manifest.chainSelector,
    deploymentBlock: manifest.blockNumber,
    manifest: {
      blockNumber: manifest.blockNumber,
      constructorArgs: manifest.constructorArgs,
      deployer: manifest.deployer,
      runtimeCodeHash: manifest.runtimeCodeHash,
      timestamp: manifest.timestamp,
      transactionHash: manifest.transactionHash,
    },
    network: networkName,
    role,
    runtimeCodeHash: manifest.runtimeCodeHash,
    status: 'DEPLOYED',
  };
}

const senderArtifactRelativePath = 'out/EtherdocSender.sol/EtherdocSender.json';
const receiverArtifactRelativePath =
  'out/EtherdocReceiver.sol/EtherdocReceiver.json';
const networksRelativePath = 'config/networks/testnet.json';
const typesRelativePath = 'src/EtherdocTypes.sol';
const senderSourceRelativePath = 'src/EtherdocSender.sol';

const senderArtifactText = readText(senderArtifactRelativePath);
const receiverArtifactText = readText(receiverArtifactRelativePath);
const networkConfigText = readText(networksRelativePath);
const typesSource = readText(typesRelativePath);
const senderSource = readText(senderSourceRelativePath);
const senderArtifact = JSON.parse(senderArtifactText);
const receiverArtifact = JSON.parse(receiverArtifactText);
const networkConfig = parseNetworkConfig(networkConfigText);
const contractCommit = getCommit();

for (const requiredNetwork of ['ethereumSepolia', 'mantleSepolia']) {
  if (!networkConfig.networks?.[requiredNetwork]) {
    fail(`Network config is missing ${requiredNetwork}`);
  }
}

const compilerSettings = {
  evmVersion: senderArtifact.metadata?.settings?.evmVersion,
  optimizer: senderArtifact.metadata?.settings?.optimizer,
  version: senderArtifact.metadata?.compiler?.version,
};
const receiverCompilerSettings = {
  evmVersion: receiverArtifact.metadata?.settings?.evmVersion,
  optimizer: receiverArtifact.metadata?.settings?.optimizer,
  version: receiverArtifact.metadata?.compiler?.version,
};
if (
  stableJson(compilerSettings) !== stableJson(receiverCompilerSettings) ||
  !compilerSettings.version
) {
  fail('Sender and receiver compiler settings do not match');
}

const protocol = {
  canonicalCidLength: extractNumber(
    typesSource,
    /CANONICAL_CID_LENGTH\s*=\s*(\d+)\s*;/,
    'canonical CID length',
  ),
  cid: {
    codecs: {
      dagPb: extractHexNumber(
        typesSource,
        /CID_CODEC_DAG_PB\s*=\s*0x([0-9a-fA-F]+)\s*;/,
        'dag-pb CID codec',
      ),
      raw: extractHexNumber(
        typesSource,
        /CID_CODEC_RAW\s*=\s*0x([0-9a-fA-F]+)\s*;/,
        'raw CID codec',
      ),
    },
    multihash: 'sha2-256',
    version: extractNumber(
      typesSource,
      /CID_VERSION\s*=\s*(\d+)\s*;/,
      'CID version',
    ),
  },
  documentId: 'keccak256(abi.encode(issuer,contentDigest))',
  eip712Domain: extractDomain(senderSource),
  payloadLength: extractNumber(
    typesSource,
    /PAYLOAD_LENGTH\s*=\s*(\d+)\s*;/,
    'payload length',
  ),
  payloadSchemaVersion: extractNumber(
    typesSource,
    /SCHEMA_VERSION\s*=\s*(\d+)\s*;/,
    'payload schema version',
  ),
};

const sourceNetwork = networkConfig.networks.ethereumSepolia;
const destinationNetwork = networkConfig.networks.mantleSepolia;
const deployments = {
  receiver: getDeployment(
    'mantleSepolia',
    'receiver',
    destinationNetwork,
    contractCommit,
  ),
  sender: getDeployment(
    'ethereumSepolia',
    'sender',
    sourceNetwork,
    contractCommit,
  ),
};

const contractData = {
  compiler: compilerSettings,
  contractCommit,
  contracts: {
    receiver: {
      abi: receiverArtifact.abi,
      contractName: 'EtherdocReceiver',
    },
    sender: {
      abi: senderArtifact.abi,
      contractName: 'EtherdocSender',
    },
  },
  deployments,
  networks: networkConfig.networks,
  protocol,
};
const contentChecksum = sha256(stableJson(contractData));
const generatedArtifact = {
  ...contractData,
  provenance: {
    contentChecksum: `sha256:${contentChecksum}`,
    inputs: {
      networkConfig: `sha256:${sha256(networkConfigText)}`,
      receiverArtifact: `sha256:${sha256(receiverArtifactText)}`,
      senderArtifact: `sha256:${sha256(senderArtifactText)}`,
      senderSource: `sha256:${sha256(senderSource)}`,
      typesSource: `sha256:${sha256(typesSource)}`,
    },
    sourceRepository: 'https://github.com/harundarat/sc-etherdoc',
  },
  schemaVersion: 1,
};
const output = [
  '// Generated by scripts/sync-contract-artifacts.mjs. Do not edit manually.',
  `export const etherdocContractArtifacts = ${stableJson(generatedArtifact).trim()} as const;`,
  '',
  'export type EtherdocContractArtifacts = typeof etherdocContractArtifacts;',
  '',
].join('\n');

if (checkOnly) {
  if (!existsSync(outputPath)) {
    fail(`Generated artifact is missing: ${outputPath}`);
  }
  const existingOutput = readFileSync(outputPath, 'utf8');
  if (existingOutput !== output) {
    fail(
      'Generated contract artifacts are stale. Run `pnpm contracts:sync` and commit the result.',
    );
  }
  process.stdout.write(
    `Contract artifact drift check passed for ${contractCommit}\n`,
  );
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output);
  process.stdout.write(
    `Generated contract artifacts from ${contractCommit} at ${outputPath}\n`,
  );
}
