import {
  Injectable, NotFoundException, ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { CreateEngagementDto } from './dto/create-engagement.dto';
import { EngagementStatus, MilestoneKind, MilestoneStatus } from '@prisma/client';
import { addDays } from '../../common/utils/date.util';

@Injectable()
export class EngagementsService {
  private readonly logger = new Logger(EngagementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
  ) {}

  // ----------------------------------------------------------
  // CREATE — called after the on-chain tx is confirmed
  // ----------------------------------------------------------

  /**
   * Registers a new engagement in the DB after the company has
   * submitted the create_engagement tx on-chain via Freighter.
   * Also creates RetentionSchedule records for the cron job.
   */
  async create(dto: CreateEngagementDto) {
    const existing = await this.prisma.engagement.findUnique({
      where: { id: dto.engagementId },
    });
    if (existing) {
      throw new ConflictException(`Engagement ${dto.engagementId} already exists`);
    }

    const currentLedger = await this.stellar.getLatestLedger();

    // Build milestone records with unlock estimates for Retention milestones
    const milestoneData = dto.milestones.map((m, index) => {
      const isRetention = m.kind === 'RETENTION';
      const retentionDays = isRetention && dto.retentionDays?.[
        dto.milestones.filter((x, i) => x.kind === 'RETENTION' && i <= index).length - 1
      ];

      // valid_after_ledger = creation_ledger + (days × 17280)
      const validAfterLedger = isRetention && retentionDays
        ? (dto.createdLedger ?? currentLedger) + (retentionDays * 17_280)
        : null;

      const unlockEstimatedAt = validAfterLedger
        ? this.stellar.ledgerToDateTime(validAfterLedger, currentLedger)
        : null;

      return {
        milestoneIndex: index,
        name: m.name,
        kind: m.kind as MilestoneKind,
        paymentPercent: m.paymentPercent,
        retentionDays: isRetention ? retentionDays : null,
        validAfterLedger: validAfterLedger ?? null,
        unlockEstimatedAt,
        status: isRetention
          ? MilestoneStatus.LOCKED
          : MilestoneStatus.PENDING,
      };
    });

    const engagement = await this.prisma.engagement.create({
      data: {
        id: dto.engagementId,
        companyAddress: dto.companyAddress,
        recruiterAddress: dto.recruiterAddress,
        arbiterAddress: dto.arbiterAddress,
        tokenAddress: dto.tokenAddress,
        totalAmount: BigInt(dto.totalAmount),
        jobTitle: dto.jobTitle,
        jobDescription: dto.jobDescription,
        salaryRange: dto.salaryRange,
        location: dto.location,
        txHash: dto.txHash,
        createdLedger: dto.createdLedger ?? currentLedger,
        milestones: { create: milestoneData },
      },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    // Create retention schedule entries for the cron job
    for (const m of engagement.milestones) {
      if (m.kind === MilestoneKind.RETENTION && m.unlockEstimatedAt) {
        await this.prisma.retentionSchedule.create({
          data: {
            engagementId: engagement.id,
            milestoneIndex: m.milestoneIndex,
            validAfterLedger: m.validAfterLedger!,
            unlockAt: m.unlockEstimatedAt,
            notifyAt: new Date(m.unlockEstimatedAt.getTime() - 3 * 24 * 60 * 60 * 1000), // 3 days before
          },
        });
      }
    }

    this.logger.log(`Engagement created: ${engagement.id}`);
    return this.serialize(engagement);
  }

  // ----------------------------------------------------------
  // READ
  // ----------------------------------------------------------

  async findAll(filters: {
    companyAddress?: string;
    recruiterAddress?: string;
    status?: EngagementStatus;
    page?: number;
    limit?: number;
  }) {
    const { companyAddress, recruiterAddress, status, page = 1, limit = 20 } = filters;

    const where: any = {};
    if (companyAddress) where.companyAddress = companyAddress;
    if (recruiterAddress) where.recruiterAddress = recruiterAddress;
    if (status) where.status = status;

    const [engagements, total] = await this.prisma.$transaction([
      this.prisma.engagement.findMany({
        where,
        include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.engagement.count({ where }),
    ]);

    return {
      data: engagements.map(this.serialize),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id },
      include: {
        milestones: { orderBy: { milestoneIndex: 'asc' } },
        events: { orderBy: { ledger: 'desc' }, take: 20 },
      },
    });
    if (!engagement) throw new NotFoundException(`Engagement ${id} not found`);
    return this.serialize(engagement);
  }

  // ----------------------------------------------------------
  // SYNC FROM CHAIN
  // ----------------------------------------------------------

  /**
   * Re-read the engagement status from Stellar and update the DB.
   * Called by EventsService after relevant on-chain events, or manually.
   */
  async syncFromChain(engagementId: string) {
    try {
      const { nativeToScVal } = await import('@stellar/stellar-sdk');
      const onChain = await this.stellar.simulateContractCall('get_engagement', [
        nativeToScVal(engagementId, { type: 'string' }),
      ]);
      if (!onChain) return;

      const statusMap: Record<string, EngagementStatus> = {
        Active: EngagementStatus.ACTIVE,
        Completed: EngagementStatus.COMPLETED,
        Cancelled: EngagementStatus.CANCELLED,
        ReplacementRequested: EngagementStatus.REPLACEMENT_REQUESTED,
      };

      await this.prisma.engagement.update({
        where: { id: engagementId },
        data: {
          status: statusMap[onChain.status] ?? EngagementStatus.ACTIVE,
          releasedAmount: BigInt(onChain.released_amount ?? 0),
        },
      });

      this.logger.log(`Synced engagement ${engagementId} from chain`);
    } catch (error) {
      this.logger.error(`Failed to sync ${engagementId}`, error.message);
    }
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  private serialize(engagement: any) {
    return {
      ...engagement,
      totalAmount: engagement.totalAmount?.toString(),
      releasedAmount: engagement.releasedAmount?.toString(),
      milestones: engagement.milestones?.map((m: any) => ({
        ...m,
        paymentReleased: m.paymentReleased?.toString() ?? null,
      })),
    };
  }
}
