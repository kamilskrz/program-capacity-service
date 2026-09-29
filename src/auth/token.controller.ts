import { Body, Controller, NotFoundException, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { JWT_AUDIENCE, JWT_ISSUER } from './claims';
import { IssueTokenDto } from './issue-token.dto';
import { Public } from './public.decorator';
import { AppConfigService } from '../shared/config/app-config.service';

/** What signing a token hands back. */
export interface IssuedToken {
  readonly accessToken: string;
}

/**
 * A development convenience, not a security boundary (docs/PLAN.md 2.7):
 * refuses with `404` in production, otherwise signs whatever `{ sub, org,
 * scope }` the body states with a 1-hour expiry.
 */
@Controller('auth')
export class TokenController {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @Post('token')
  async issue(@Body() dto: IssueTokenDto): Promise<IssuedToken> {
    if (this.config.isProduction) {
      throw new NotFoundException();
    }

    const accessToken = await this.jwtService.signAsync(
      { sub: dto.sub, org: dto.org, scope: dto.scope },
      {
        secret: this.config.jwtSecret,
        algorithm: 'HS256',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn: '1h',
      },
    );

    return { accessToken };
  }
}
