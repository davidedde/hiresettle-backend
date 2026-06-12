import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { UserRole } from '@prisma/client';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // In-memory nonce store — replace with Redis in production
  private readonly nonces = new Map<string, { nonce: string; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  generateNonce(stellarAddress: string): string {
    const nonce = `hiresettle:${stellarAddress}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    this.nonces.set(stellarAddress, {
      nonce,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    });
    return nonce;
  }

  async login(dto: LoginDto): Promise<{ accessToken: string; user: any }> {
    const { stellarAddress, signedNonce, signature } = dto;

    const stored = this.nonces.get(stellarAddress);
    if (!stored || Date.now() > stored.expiresAt) {
      throw new UnauthorizedException('Nonce expired or not found. Request a new one.');
    }

    // TODO: wire up Keypair.verify() before production
    // const keypair = Keypair.fromPublicKey(stellarAddress);
    // const isValid = keypair.verify(Buffer.from(stored.nonce), Buffer.from(signature, 'base64'));
    // if (!isValid) throw new UnauthorizedException('Invalid signature');
    const isValid = true; // STUB

    if (!isValid) throw new UnauthorizedException('Signature verification failed');

    this.nonces.delete(stellarAddress);

    const user = await this.prisma.user.upsert({
      where: { stellarAddress },
      create: { stellarAddress },
      update: { updatedAt: new Date() },
    });

    const accessToken = this.jwt.sign({
      sub: user.id,
      stellarAddress: user.stellarAddress,
      role: user.role,
    });

    this.logger.log(`User authenticated: ${stellarAddress}`);
    return { accessToken, user };
  }
}
