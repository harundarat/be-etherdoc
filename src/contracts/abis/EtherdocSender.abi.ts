export const etherdocSenderAbi = [
  {
    inputs: [
      { internalType: 'address', name: '_router', type: 'address' },
      { internalType: 'address', name: '_link', type: 'address' },
    ],
    stateMutability: 'nonpayable',
    type: 'constructor',
  },
  {
    inputs: [
      {
        internalType: 'uint64',
        name: 'destinationChainSelector',
        type: 'uint64',
      },
    ],
    name: 'DestinationChainNotAllowlisted',
    type: 'error',
  },
  {
    inputs: [{ internalType: 'string', name: 'documentCID', type: 'string' }],
    name: 'DocumentAlreadyExists',
    type: 'error',
  },
  { inputs: [], name: 'InvalidReceiverAddress', type: 'error' },
  {
    inputs: [
      { internalType: 'uint256', name: 'currentBalance', type: 'uint256' },
      { internalType: 'uint256', name: 'calculatedFees', type: 'uint256' },
    ],
    name: 'NotEnoughBalance',
    type: 'error',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'messageId',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'uint64',
        name: 'destinationChainSelector',
        type: 'uint64',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'receiver',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'documentCID',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'feeToken',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'fees',
        type: 'uint256',
      },
    ],
    name: 'MessageSent',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'from', type: 'address' },
      { indexed: true, internalType: 'address', name: 'to', type: 'address' },
    ],
    name: 'OwnershipTransferRequested',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'from', type: 'address' },
      { indexed: true, internalType: 'address', name: 'to', type: 'address' },
    ],
    name: 'OwnershipTransferred',
    type: 'event',
  },
  {
    inputs: [],
    name: 'acceptOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint64',
        name: '_destinationChainSelector',
        type: 'uint64',
      },
      { internalType: 'address', name: '_receiver', type: 'address' },
      { internalType: 'string', name: '_documentCID', type: 'string' },
    ],
    name: 'addDocument',
    outputs: [{ internalType: 'bytes32', name: 'messageId', type: 'bytes32' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint64',
        name: '_destinationChainSelector',
        type: 'uint64',
      },
      { internalType: 'bool', name: '_allowlisted', type: 'bool' },
    ],
    name: 'allowlistDestinationChain',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'string', name: '_documentCID', type: 'string' }],
    name: 'documentExists',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'owner',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'to', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;
