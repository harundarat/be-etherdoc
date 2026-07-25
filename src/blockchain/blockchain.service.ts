import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { etherdocContractArtifacts } from '../contracts/generated';
import type { RuntimeConfig } from '../config/runtime-config';
import {
  BlockchainClientError,
  BlockchainErrorKind,
  classifyBlockchainError,
} from './blockchain.errors';

type EtherdocPublicClient = ReturnType<typeof createPublicClient>;
type EtherdocWalletClient = ReturnType<typeof createWalletClient>;

function networkChain(
  id: number,
  name: string,
  rpcUrl: string,
  explorerUrl: string,
) {
  return defineChain({
    id,
    name,
    nativeCurrency: {
      decimals: 18,
      name: `${name} native token`,
      symbol: 'ETH',
    },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
    blockExplorers: {
      default: { name: `${name} explorer`, url: explorerUrl },
    },
    testnet: true,
  });
}

@Injectable()
export class BlockchainService implements OnModuleInit {
  private readonly logger = new Logger(BlockchainService.name);
  private readonly runtime: RuntimeConfig;

  readonly destinationReader: EtherdocPublicClient;
  readonly operatorDispatch: EtherdocWalletClient;
  readonly relayerSubmission: EtherdocWalletClient;
  readonly sourceReader: EtherdocPublicClient;

  constructor(configService: ConfigService) {
    this.runtime = configService.getOrThrow<RuntimeConfig>('runtime');
    const { blockchain } = this.runtime;
    const sourceChain = networkChain(
      blockchain.source.chainId,
      blockchain.source.name,
      blockchain.source.rpcUrl,
      blockchain.source.explorerUrl,
    );
    const destinationChain = networkChain(
      blockchain.destination.chainId,
      blockchain.destination.name,
      blockchain.destination.rpcUrl,
      blockchain.destination.explorerUrl,
    );
    const account = privateKeyToAccount(blockchain.signerPrivateKey);
    const transportOptions = { timeout: blockchain.requestTimeoutMs };

    this.sourceReader = createPublicClient({
      chain: sourceChain,
      transport: http(blockchain.source.rpcUrl, transportOptions),
    });
    this.destinationReader = createPublicClient({
      chain: destinationChain,
      transport: http(blockchain.destination.rpcUrl, transportOptions),
    });
    this.relayerSubmission = createWalletClient({
      account,
      chain: sourceChain,
      transport: http(blockchain.source.rpcUrl, transportOptions),
    });
    this.operatorDispatch = createWalletClient({
      account,
      chain: sourceChain,
      transport: http(blockchain.source.rpcUrl, transportOptions),
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.assertReady();
    } catch (error) {
      const classified = classifyBlockchainError(
        error,
        'Blockchain readiness check failed',
      );
      this.logger.error(`${classified.kind}: ${classified.message}`);
      throw new ServiceUnavailableException({
        error: 'BLOCKCHAIN_NOT_READY',
        kind: classified.kind,
        message: classified.message,
      });
    }
  }

  get config(): RuntimeConfig['blockchain'] {
    return this.runtime.blockchain;
  }

  async assertReady(): Promise<void> {
    const { source, destination, signerAddress } = this.runtime.blockchain;
    const [sourceChainId, destinationChainId] = await Promise.all([
      this.sourceReader.getChainId(),
      this.destinationReader.getChainId(),
    ]);
    if (sourceChainId !== source.chainId) {
      throw new BlockchainClientError(
        BlockchainErrorKind.CHAIN_MISMATCH,
        `Source RPC chain mismatch: expected ${source.chainId}, received ${sourceChainId}`,
      );
    }
    if (destinationChainId !== destination.chainId) {
      throw new BlockchainClientError(
        BlockchainErrorKind.CHAIN_MISMATCH,
        `Destination RPC chain mismatch: expected ${destination.chainId}, received ${destinationChainId}`,
      );
    }

    const [senderCode, receiverCode] = await Promise.all([
      this.sourceReader.getBytecode({ address: source.contractAddress }),
      this.destinationReader.getBytecode({
        address: destination.contractAddress,
      }),
    ]);
    if (!senderCode || senderCode === '0x') {
      throw new BlockchainClientError(
        BlockchainErrorKind.NOT_FOUND,
        `No sender runtime bytecode at ${source.contractAddress}`,
      );
    }
    if (!receiverCode || receiverCode === '0x') {
      throw new BlockchainClientError(
        BlockchainErrorKind.NOT_FOUND,
        `No receiver runtime bytecode at ${destination.contractAddress}`,
      );
    }
    const expectedSenderCodeHash =
      etherdocContractArtifacts.deployments.sender.runtimeCodeHash;
    const expectedReceiverCodeHash =
      etherdocContractArtifacts.deployments.receiver.runtimeCodeHash;
    if (
      expectedSenderCodeHash &&
      keccak256(senderCode) !== expectedSenderCodeHash
    ) {
      throw new BlockchainClientError(
        BlockchainErrorKind.CHAIN_MISMATCH,
        `Sender runtime bytecode hash does not match the deployment manifest`,
      );
    }
    if (
      expectedReceiverCodeHash &&
      keccak256(receiverCode) !== expectedReceiverCodeHash
    ) {
      throw new BlockchainClientError(
        BlockchainErrorKind.CHAIN_MISMATCH,
        `Receiver runtime bytecode hash does not match the deployment manifest`,
      );
    }

    const senderAbi = etherdocContractArtifacts.contracts.sender.abi;
    const receiverAbi = etherdocContractArtifacts.contracts.receiver.abi;
    const [
      sourceRouter,
      sourceLink,
      operatorRole,
      destinationRouter,
      receiverSourceChainId,
      receiverSourceSelector,
      trustedSender,
    ] = await Promise.all([
      this.sourceReader.readContract({
        abi: senderAbi,
        address: source.contractAddress,
        functionName: 'getRouter',
      }),
      this.sourceReader.readContract({
        abi: senderAbi,
        address: source.contractAddress,
        functionName: 'getFeeToken',
      }),
      this.sourceReader.readContract({
        abi: senderAbi,
        address: source.contractAddress,
        functionName: 'OPERATOR_ROLE',
      }),
      this.destinationReader.readContract({
        abi: receiverAbi,
        address: destination.contractAddress,
        functionName: 'getRouter',
      }),
      this.destinationReader.readContract({
        abi: receiverAbi,
        address: destination.contractAddress,
        functionName: 'getSourceChainId',
      }),
      this.destinationReader.readContract({
        abi: receiverAbi,
        address: destination.contractAddress,
        functionName: 'getSourceChainSelector',
      }),
      this.destinationReader.readContract({
        abi: receiverAbi,
        address: destination.contractAddress,
        functionName: 'getTrustedSender',
      }),
    ]);

    this.assertAddress(sourceRouter, source.router, 'sender router');
    this.assertAddress(sourceLink, source.linkToken, 'sender LINK token');
    this.assertAddress(
      destinationRouter,
      destination.router,
      'receiver router',
    );
    this.assertAddress(trustedSender, source.contractAddress, 'trusted sender');
    if (receiverSourceChainId !== BigInt(source.chainId)) {
      throw new BlockchainClientError(
        BlockchainErrorKind.CHAIN_MISMATCH,
        'Receiver source chain ID does not match Mantle Sepolia',
      );
    }
    if (receiverSourceSelector !== source.chainSelector) {
      throw new BlockchainClientError(
        BlockchainErrorKind.CHAIN_MISMATCH,
        'Receiver source selector does not match Mantle Sepolia',
      );
    }

    const isOperator = await this.sourceReader.readContract({
      abi: senderAbi,
      address: source.contractAddress,
      functionName: 'hasRole',
      args: [operatorRole, signerAddress],
    });
    if (!isOperator) {
      throw new BlockchainClientError(
        BlockchainErrorKind.CONTRACT_REVERT,
        `Backend signer ${signerAddress} does not have OPERATOR_ROLE`,
      );
    }
  }

  private assertAddress(
    actual: Address,
    expected: Address,
    label: string,
  ): void {
    if (getAddress(actual) !== getAddress(expected)) {
      throw new BlockchainClientError(
        BlockchainErrorKind.CHAIN_MISMATCH,
        `${label} mismatch: expected ${expected}, received ${actual}`,
      );
    }
  }
}
