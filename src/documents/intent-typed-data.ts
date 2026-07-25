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
