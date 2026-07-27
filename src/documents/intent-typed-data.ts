import {
  hashTypedData,
  type Address,
  type Hex,
  type TypedData,
  type TypedDataDomain,
} from 'viem';

export const REGISTER_DOCUMENT_TYPES = {
  RegisterDocument: [
    { name: 'issuer', type: 'address' },
    { name: 'documentId', type: 'bytes32' },
    { name: 'contentDigest', type: 'bytes32' },
    { name: 'cidCodec', type: 'uint8' },
    { name: 'cidDigest', type: 'bytes32' },
    { name: 'metadataCommitment', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const satisfies TypedData;

export const REVOKE_DOCUMENT_TYPES = {
  RevokeDocument: [
    { name: 'issuer', type: 'address' },
    { name: 'documentId', type: 'bytes32' },
    { name: 'currentVersion', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const satisfies TypedData;

export const SUPERSEDE_DOCUMENT_TYPES = {
  SupersedeDocument: [
    { name: 'issuer', type: 'address' },
    { name: 'oldDocumentId', type: 'bytes32' },
    { name: 'currentVersion', type: 'uint64' },
    { name: 'newDocumentId', type: 'bytes32' },
    { name: 'newContentDigest', type: 'bytes32' },
    { name: 'newCidCodec', type: 'uint8' },
    { name: 'newCidDigest', type: 'bytes32' },
    { name: 'metadataCommitment', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const satisfies TypedData;

export interface IntentDomainParameters {
  chainId: number;
  verifyingContract: Address;
}

export interface RegisterAuthorization {
  [key: string]: unknown;
  cidCodec: number;
  cidDigest: Hex;
  contentDigest: Hex;
  deadline: bigint;
  documentId: Hex;
  issuer: Address;
  metadataCommitment: Hex;
  nonce: bigint;
}

export interface RevokeAuthorization {
  [key: string]: unknown;
  currentVersion: bigint;
  deadline: bigint;
  documentId: Hex;
  issuer: Address;
  nonce: bigint;
}

export interface SupersedeAuthorization {
  [key: string]: unknown;
  currentVersion: bigint;
  deadline: bigint;
  issuer: Address;
  metadataCommitment: Hex;
  newCidCodec: number;
  newCidDigest: Hex;
  newContentDigest: Hex;
  newDocumentId: Hex;
  nonce: bigint;
  oldDocumentId: Hex;
}

type IntentOperation = 'REGISTER' | 'REVOKE' | 'SUPERSEDE';

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`typed_data.message.${key} must be a non-empty string`);
  }
  return value;
}

function bytes32Value(record: Record<string, unknown>, key: string): Hex {
  const value = stringValue(record, key);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`typed_data.message.${key} must be bytes32`);
  }
  return value as Hex;
}

function bigintValue(record: Record<string, unknown>, key: string): bigint {
  const value = stringValue(record, key);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`typed_data.message.${key} must be an unsigned integer`);
  }
  return BigInt(value);
}

function uint8Value(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 255
  ) {
    throw new Error(`typed_data.message.${key} must be a uint8`);
  }
  return value;
}

export function parseIntentAuthorization(
  operation: 'REGISTER',
  typedData: unknown,
  issuer: Address,
): RegisterAuthorization;
export function parseIntentAuthorization(
  operation: 'REVOKE',
  typedData: unknown,
  issuer: Address,
): RevokeAuthorization;
export function parseIntentAuthorization(
  operation: 'SUPERSEDE',
  typedData: unknown,
  issuer: Address,
): SupersedeAuthorization;
export function parseIntentAuthorization(
  operation: IntentOperation,
  typedData: unknown,
  issuer: Address,
): RegisterAuthorization | RevokeAuthorization | SupersedeAuthorization {
  const root = objectValue(typedData, 'typed_data');
  const expectedPrimaryType = {
    REGISTER: 'RegisterDocument',
    REVOKE: 'RevokeDocument',
    SUPERSEDE: 'SupersedeDocument',
  }[operation];
  if (root.primaryType !== expectedPrimaryType) {
    throw new Error(`typed_data.primaryType must be ${expectedPrimaryType}`);
  }
  const message = objectValue(root.message, 'typed_data.message');
  const base = {
    deadline: bigintValue(message, 'deadline'),
    issuer,
    nonce: bigintValue(message, 'nonce'),
  };
  if (operation === 'REGISTER') {
    return {
      ...base,
      cidCodec: uint8Value(message, 'cidCodec'),
      cidDigest: bytes32Value(message, 'cidDigest'),
      contentDigest: bytes32Value(message, 'contentDigest'),
      documentId: bytes32Value(message, 'documentId'),
      metadataCommitment: bytes32Value(message, 'metadataCommitment'),
    };
  }
  if (operation === 'REVOKE') {
    return {
      ...base,
      currentVersion: bigintValue(message, 'currentVersion'),
      documentId: bytes32Value(message, 'documentId'),
    };
  }
  return {
    ...base,
    currentVersion: bigintValue(message, 'currentVersion'),
    metadataCommitment: bytes32Value(message, 'metadataCommitment'),
    newCidCodec: uint8Value(message, 'newCidCodec'),
    newCidDigest: bytes32Value(message, 'newCidDigest'),
    newContentDigest: bytes32Value(message, 'newContentDigest'),
    newDocumentId: bytes32Value(message, 'newDocumentId'),
    oldDocumentId: bytes32Value(message, 'oldDocumentId'),
  };
}

export function intentDomain(
  parameters: IntentDomainParameters,
): TypedDataDomain {
  return {
    chainId: parameters.chainId,
    name: 'Etherdoc',
    verifyingContract: parameters.verifyingContract,
    version: '2',
  };
}

export function registerTypedData(
  domainParameters: IntentDomainParameters,
  message: RegisterAuthorization,
) {
  return {
    domain: intentDomain(domainParameters),
    message,
    primaryType: 'RegisterDocument' as const,
    types: REGISTER_DOCUMENT_TYPES,
  };
}

export function revokeTypedData(
  domainParameters: IntentDomainParameters,
  message: RevokeAuthorization,
) {
  return {
    domain: intentDomain(domainParameters),
    message,
    primaryType: 'RevokeDocument' as const,
    types: REVOKE_DOCUMENT_TYPES,
  };
}

export function supersedeTypedData(
  domainParameters: IntentDomainParameters,
  message: SupersedeAuthorization,
) {
  return {
    domain: intentDomain(domainParameters),
    message,
    primaryType: 'SupersedeDocument' as const,
    types: SUPERSEDE_DOCUMENT_TYPES,
  };
}

export function typedDataDigest(
  typedData:
    | ReturnType<typeof registerTypedData>
    | ReturnType<typeof revokeTypedData>
    | ReturnType<typeof supersedeTypedData>,
): Hex {
  if (typedData.primaryType === 'RegisterDocument') {
    return hashTypedData(typedData);
  }
  if (typedData.primaryType === 'RevokeDocument') {
    return hashTypedData(typedData);
  }
  return hashTypedData(typedData);
}

export function jsonTypedData(
  typedData:
    | ReturnType<typeof registerTypedData>
    | ReturnType<typeof revokeTypedData>
    | ReturnType<typeof supersedeTypedData>,
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(typedData, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  ) as Record<string, unknown>;
}
