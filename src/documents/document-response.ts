import type { Address, Hex } from 'viem';
import type { BlockchainErrorKind } from '../blockchain/blockchain.errors';
import type { StorageAvailability } from '../storage/pinata-storage.service';
import type { DocumentLifecycleStatus } from './document-status';

export type DispatchStatus =
  | 'DESTINATION_CONFIRMED'
  | 'DESTINATION_IGNORED'
  | 'PENDING'
  | 'RECOVERY_REQUIRED'
  | 'SOURCE_ACCEPTED';

export interface CanonicalDocumentResponse {
  cid: string;
  cidCodec: number;
  cidDigest: Hex;
  contentDigest: Hex;
  documentId: Hex;
  issuer: Address;
  metadataCommitment: Hex;
  registeredAt: string;
  schemaVersion: number;
  sourceChainId: string;
  status: DocumentLifecycleStatus;
  supersededBy: Hex | null;
  supersedes: Hex | null;
  updatedAt: string;
  version: string;
}

export interface SourceEvidenceResponse {
  blockHash: Hex | null;
  blockNumber: string | null;
  canonical?: boolean;
  chainId: number;
  chainSelector: string;
  confirmationDepth: number;
  confirmations?: string;
  confirmationStatus: 'CONFIRMED' | 'MISMATCH' | 'UNAVAILABLE' | 'UNINDEXED';
  contractAddress: Address;
  errorKind?: BlockchainErrorKind;
  projectionMatches?: boolean;
  transactionHash: Hex | null;
}

export interface DestinationEvidenceResponse {
  chainId: number;
  chainSelector: string;
  contractAddress: Address;
  destinationEvidence: {
    blockHash: Hex | null;
    blockNumber: string | null;
    confirmedAt: string | null;
    transactionHash: Hex | null;
  };
  effectiveStatus:
    DispatchStatus | 'EVIDENCE_MISMATCH' | 'EVIDENCE_UNAVAILABLE';
  failure: { code: string; detail: string | null } | null;
  fee: {
    amount: string | null;
    gasLimit: number;
    token: Address | null;
  };
  messageId: Hex | null;
  receiver:
    | { readStatus: 'NOT_SUBMITTED' }
    | {
        active: boolean;
        integrityMatches: boolean;
        processed: boolean;
        provenanceMatches: boolean;
        readStatus: 'AVAILABLE';
        receiptStatus: number;
        replicated: boolean;
        version: string;
      }
    | {
        errorKind: BlockchainErrorKind;
        readStatus: 'UNAVAILABLE';
      };
  sourceEvidence: {
    blockHash: Hex | null;
    blockNumber: string | null;
    transactionHash: Hex | null;
  };
  status: DispatchStatus;
  version: string;
}

export interface DocumentVerificationResponse {
  canonicalSource: true;
  destinations: DestinationEvidenceResponse[];
  document: CanonicalDocumentResponse;
  integrity: {
    active: boolean;
    contentMatches: boolean;
    issuerMatches: boolean;
    matches: boolean;
  };
  source: SourceEvidenceResponse;
  storage: StorageAvailability & {
    authenticity: 'NOT_INFERRED_FROM_AVAILABILITY';
  };
}
