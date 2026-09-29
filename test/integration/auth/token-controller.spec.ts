import { NotFoundException } from '@nestjs/common';
import { type JwtService } from '@nestjs/jwt';

import { TokenController } from '../../../src/auth/token.controller';
import { type AppConfigService } from '../../../src/shared/config/app-config.service';

// Unit-level on purpose: the branch under test is `NODE_ENV === 'production'`
// plus signing, neither of which needs Postgres or a real Nest application —
// spinning up Testcontainers for this would only slow the suite down. It
// lives here (not under `src/`) because the task places it in a new
// `test/integration/auth/` directory; nothing about it actually needs the
// containers `test/integration`'s `globalSetup` starts.
function createConfig(
  nodeEnv: 'development' | 'test' | 'production',
): AppConfigService {
  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
  } as unknown as AppConfigService;
}

describe('POST /auth/token', () => {
  it('signs whatever { sub, org, scope } the body states, outside production', async () => {
    const signAsync = jest.fn().mockResolvedValue('signed-token');
    const controller = new TokenController(
      { signAsync } as unknown as JwtService,
      createConfig('development'),
    );

    await expect(
      controller.issue({
        sub: 'user-1',
        org: 'org-northwind',
        scope: 'capacity:write',
      }),
    ).resolves.toEqual({ accessToken: 'signed-token' });
  });

  it('refuses with 404 in production, so the route looks like it does not exist there', async () => {
    const signAsync = jest.fn();
    const controller = new TokenController(
      { signAsync } as unknown as JwtService,
      createConfig('production'),
    );

    await expect(
      controller.issue({
        sub: 'user-1',
        org: 'org-northwind',
        scope: 'capacity:write',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(signAsync).not.toHaveBeenCalled();
  });
});
