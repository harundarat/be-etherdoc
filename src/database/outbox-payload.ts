import type { OutboxJobType } from '../config/runtime-config';

export interface OutboxPayload {
  correlationId?: string;
  dispatchId?: string;
  intentId?: string;
  invalidReason?: string;
  transactionId?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function optionalString(
  value: unknown,
  key: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error(`${key} must be a non-empty bounded string`);
  }
  return value;
}

export function parseOutboxPayload(
  jobType: OutboxJobType,
  value: unknown,
): OutboxPayload {
  try {
    const source = record(value);
    if (!source) {
      throw new Error('payload must be an object');
    }
    const payload: OutboxPayload = {
      correlationId: optionalString(source.correlationId, 'correlationId', 128),
      dispatchId: optionalString(source.dispatchId, 'dispatchId', 128),
      intentId: optionalString(source.intentId, 'intentId', 128),
      transactionId: optionalString(source.transactionId, 'transactionId', 128),
    };
    if (
      (jobType === 'SUBMIT_SOURCE' || jobType === 'CONFIRM_SOURCE') &&
      !payload.intentId
    ) {
      throw new Error(`${jobType} requires intentId`);
    }
    if (
      (jobType === 'DISPATCH_DESTINATION' || jobType === 'TRACK_DESTINATION') &&
      !payload.dispatchId
    ) {
      throw new Error(`${jobType} requires dispatchId`);
    }
    if (
      jobType === 'RECONCILE' &&
      !payload.dispatchId &&
      !(payload.intentId && payload.transactionId)
    ) {
      throw new Error(
        'RECONCILE requires dispatchId or intentId with transactionId',
      );
    }
    return payload;
  } catch (error) {
    return {
      invalidReason:
        error instanceof Error ? error.message : 'payload is invalid',
    };
  }
}
