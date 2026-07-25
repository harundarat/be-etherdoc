export enum BlockchainErrorKind {
  CHAIN_MISMATCH = 'CHAIN_MISMATCH',
  CONTRACT_REVERT = 'CONTRACT_REVERT',
  NOT_FOUND = 'NOT_FOUND',
  RPC_UNAVAILABLE = 'RPC_UNAVAILABLE',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

export class BlockchainClientError extends Error {
  constructor(
    readonly kind: BlockchainErrorKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = BlockchainClientError.name;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.toLowerCase();
  }
  return String(error).toLowerCase();
}

export function classifyBlockchainError(
  error: unknown,
  message = 'Blockchain request failed',
): BlockchainClientError {
  if (error instanceof BlockchainClientError) {
    return error;
  }
  const text = errorText(error);
  if (text.includes('timeout') || text.includes('timed out')) {
    return new BlockchainClientError(
      BlockchainErrorKind.TIMEOUT,
      message,
      error,
    );
  }
  if (
    text.includes('chain mismatch') ||
    text.includes('chain id') ||
    text.includes('chainid')
  ) {
    return new BlockchainClientError(
      BlockchainErrorKind.CHAIN_MISMATCH,
      message,
      error,
    );
  }
  if (
    text.includes('execution reverted') ||
    text.includes('contractfunctionrevertederror') ||
    text.includes('revert')
  ) {
    return new BlockchainClientError(
      BlockchainErrorKind.CONTRACT_REVERT,
      message,
      error,
    );
  }
  if (
    text.includes('fetch failed') ||
    text.includes('network') ||
    text.includes('connection') ||
    text.includes('http request failed') ||
    text.includes('rpc')
  ) {
    return new BlockchainClientError(
      BlockchainErrorKind.RPC_UNAVAILABLE,
      message,
      error,
    );
  }
  return new BlockchainClientError(
    BlockchainErrorKind.UNKNOWN,
    message,
    error,
  );
}
