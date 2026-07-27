import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RuntimeConfig } from '../config/runtime-config';
import { JwtStrategy } from './jwt.strategy';

const sourceChainId = 11_155_111;
const wallet = '0x000000000000000000000000000000000000dEaD';

function strategy(): JwtStrategy {
  const runtime = {
    blockchain: { source: { chainId: sourceChainId } },
    jwt: { secret: 'a-test-secret-with-at-least-32-characters' },
  } as RuntimeConfig;
  return new JwtStrategy(new ConfigService({ runtime }));
}

describe('JwtStrategy', () => {
  it('accepts and normalizes a source-chain wallet subject', () => {
    expect(
      strategy().validate({
        chainId: sourceChainId,
        sub: wallet.toLowerCase(),
      }),
    ).toEqual({
      address: wallet,
      chainId: sourceChainId,
    });
  });

  it('rejects a token issued for another chain', () => {
    expect(() =>
      strategy().validate({
        chainId: 5003,
        sub: wallet,
      }),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a malformed wallet subject', () => {
    expect(() =>
      strategy().validate({
        chainId: sourceChainId,
        sub: 'not-an-address',
      }),
    ).toThrow('Invalid token subject');
  });
});
