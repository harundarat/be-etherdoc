import { createHash } from 'node:crypto';
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const CID_VERSION = 1;
export const CID_CODEC_RAW = 0x55;
export const CID_CODEC_DAG_PB = 0x70;
const MULTIHASH_SHA2_256 = 0x12;
const SHA2_256_LENGTH = 32;
const CANONICAL_CID_LENGTH = 59;

export interface CanonicalMetadataInput {
  byteLength: number;
  documentType?: string;
  mimeType: string;
  storageNetwork: 'private' | 'public';
}

export interface CanonicalMetadata {
  commitment: Hex;
  json: string;
  preimage: {
    metadata: {
      byteLength: number;
      documentType?: string;
      mimeType: string;
      storageNetwork: 'private' | 'public';
    };
    schema: 'etherdoc.metadata.v1';
  };
}

export interface ParsedCanonicalCid {
  cid: string;
  cidCodec: typeof CID_CODEC_RAW | typeof CID_CODEC_DAG_PB;
  cidDigest: Hex;
}

export class CanonicalDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = CanonicalDocumentError.name;
  }
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function hexToBytes(hex: Hex): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CanonicalDocumentError('Digest must be exactly 32 bytes');
  }
  return Buffer.from(hex.slice(2), 'hex');
}

function decodeBase32(value: string): Uint8Array {
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit === -1) {
      throw new CanonicalDocumentError(
        'CID must use lowercase unpadded base32',
      );
    }
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits !== 2 || accumulator !== 0) {
    throw new CanonicalDocumentError('CID contains non-canonical padding bits');
  }
  return Uint8Array.from(bytes);
}

function encodeBase32(bytes: Uint8Array): string {
  let accumulator = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(accumulator >> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  }
  return output;
}

export function sha256Digest(bytes: Uint8Array): Hex {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

export function encodeCanonicalCid(
  cidCodec: typeof CID_CODEC_RAW | typeof CID_CODEC_DAG_PB,
  cidDigest: Hex,
): string {
  if (![CID_CODEC_RAW, CID_CODEC_DAG_PB].includes(cidCodec)) {
    throw new CanonicalDocumentError('Unsupported CID codec');
  }
  const binary = Uint8Array.from([
    CID_VERSION,
    cidCodec,
    MULTIHASH_SHA2_256,
    SHA2_256_LENGTH,
    ...hexToBytes(cidDigest),
  ]);
  return `b${encodeBase32(binary)}`;
}

export function parseCanonicalCid(
  cid: string,
  contentDigest?: Hex,
): ParsedCanonicalCid {
  if (
    cid.length !== CANONICAL_CID_LENGTH ||
    !cid.startsWith('b') ||
    cid !== cid.toLowerCase()
  ) {
    throw new CanonicalDocumentError(
      'CID must be CIDv1 lowercase unpadded base32 with canonical length',
    );
  }
  const decoded = decodeBase32(cid.slice(1));
  if (decoded.length !== 36) {
    throw new CanonicalDocumentError('CID binary length is not canonical');
  }
  const [version, codec, multihash, digestLength] = decoded;
  if (version !== CID_VERSION) {
    throw new CanonicalDocumentError('Only CIDv1 is supported');
  }
  if (codec !== CID_CODEC_RAW && codec !== CID_CODEC_DAG_PB) {
    throw new CanonicalDocumentError(
      'Only raw and dag-pb CID codecs are supported',
    );
  }
  if (multihash !== MULTIHASH_SHA2_256 || digestLength !== SHA2_256_LENGTH) {
    throw new CanonicalDocumentError('CID must use a SHA2-256 multihash');
  }
  const cidDigest = bytesToHex(decoded.slice(4));
  if (
    codec === CID_CODEC_RAW &&
    contentDigest &&
    cidDigest.toLowerCase() !== contentDigest.toLowerCase()
  ) {
    throw new CanonicalDocumentError(
      'Raw CID digest does not match the exact file digest',
    );
  }
  if (encodeCanonicalCid(codec, cidDigest) !== cid) {
    throw new CanonicalDocumentError('CID text is not canonical');
  }
  return {
    cid,
    cidCodec: codec,
    cidDigest,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function canonicalizeMetadata(
  input: CanonicalMetadataInput,
): CanonicalMetadata {
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) {
    throw new CanonicalDocumentError('Metadata byteLength must be positive');
  }
  if (
    !/^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i.test(
      input.mimeType,
    )
  ) {
    throw new CanonicalDocumentError('Metadata mimeType is invalid');
  }
  if (!['private', 'public'].includes(input.storageNetwork)) {
    throw new CanonicalDocumentError('Metadata storageNetwork is invalid');
  }
  if (
    input.documentType !== undefined &&
    (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.documentType) ||
      input.documentType.length > 64)
  ) {
    throw new CanonicalDocumentError('Metadata documentType is invalid');
  }

  const preimage = stableValue({
    metadata: {
      byteLength: input.byteLength,
      documentType: input.documentType,
      mimeType: input.mimeType.toLowerCase(),
      storageNetwork: input.storageNetwork,
    },
    schema: 'etherdoc.metadata.v1',
  }) as CanonicalMetadata['preimage'];
  const json = JSON.stringify(preimage);
  return {
    commitment: keccak256(stringToHex(json)),
    json,
    preimage,
  };
}

export function computeDocumentId(issuer: Address, contentDigest: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32' }],
      [getAddress(issuer), contentDigest],
    ),
  );
}
