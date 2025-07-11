import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, LoginResponseDto, NonceResponseDto } from './dto';
import { Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('nonce')
  async getNonce(): Promise<NonceResponseDto> {
    return await this.authService.getNonce();
  }

  @Post('login')
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponseDto> {
    const jwtToken = await this.authService.signIn(loginDto.signature);
    response.cookie('etherdoc-auth', jwtToken.accessToken, { httpOnly: true });

    return jwtToken;
  }
}
