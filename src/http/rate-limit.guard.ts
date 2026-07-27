import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { getAddress } from 'viem';
import { parseSiweMessage } from 'viem/siwe';

type RequestBody = Record<string, unknown> | undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function requestBody(request: Record<string, unknown>): RequestBody {
  const body = request.body;
  return body && typeof body === 'object' && !Array.isArray(body)
    ? Object.fromEntries(Object.entries(body))
    : undefined;
}

export function walletFromRequest(requestValue: unknown): string | undefined {
  const request = record(requestValue);
  if (!request) {
    return undefined;
  }
  const body = requestBody(request);
  const candidate =
    typeof body?.address === 'string'
      ? body.address
      : typeof body?.issuer === 'string'
        ? body.issuer
        : undefined;
  if (candidate) {
    try {
      return getAddress(candidate).toLowerCase();
    } catch {
      return undefined;
    }
  }
  if (typeof body?.message === 'string') {
    try {
      const parsed = parseSiweMessage(body.message);
      return parsed.address
        ? getAddress(parsed.address).toLowerCase()
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function clientTracker(requestValue: unknown): string {
  const request = record(requestValue);
  if (!request) {
    return 'unknown-client';
  }
  const socket = record(request.socket);
  return typeof request.ip === 'string' && request.ip
    ? request.ip
    : typeof socket?.remoteAddress === 'string' && socket.remoteAddress
      ? socket.remoteAddress
      : 'unknown-client';
}

export function walletTracker(request: unknown): string {
  return walletFromRequest(request) ?? `anonymous:${clientTracker(request)}`;
}

@Injectable()
export class EtherdocThrottlerGuard extends ThrottlerGuard {}
