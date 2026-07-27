import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { getAddress } from 'viem';
import { parseSiweMessage } from 'viem/siwe';

type RequestBody = Record<string, unknown> | undefined;

function requestBody(request: Request): RequestBody {
  return request.body &&
    typeof request.body === 'object' &&
    !Array.isArray(request.body)
    ? (request.body as Record<string, unknown>)
    : undefined;
}

export function walletFromRequest(request: Request): string | undefined {
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

export function clientTracker(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown-client';
}

export function walletTracker(request: Request): string {
  return walletFromRequest(request) ?? `anonymous:${clientTracker(request)}`;
}

@Injectable()
export class EtherdocThrottlerGuard extends ThrottlerGuard {}
