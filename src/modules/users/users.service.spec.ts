import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import { PrismaService } from '../../common/prisma/prisma.service';

const mockPrisma = {
  user: { findUnique: jest.fn() },
  notificationPreference: { findMany: jest.fn(), upsert: jest.fn() },
};

describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    jest.clearAllMocks();
  });

  describe('findByStellarAddress()', () => {
    const address = 'GABC123DEFGHIJKLMNOPQRSTUVWXYZ234567GABC123DEFGHIJKLMNOPQR';

    it('returns public fields when user exists', async () => {
      const mockUser = { name: 'Ada', company: 'HireSettle', role: UserRole.RECRUITER };
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.findByStellarAddress(address);

      expect(result).toEqual(mockUser);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { stellarAddress: address },
        select: { name: true, company: true, role: true },
      });
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findByStellarAddress(address)).rejects.toThrow(NotFoundException);
    });
  });
});
