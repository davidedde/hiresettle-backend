import { Injectable, NotFoundException, Logger, UnprocessableEntityException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { S3Service } from '../../common/s3/s3.service';
import { MilestoneStatus, UserRole } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class MilestonesService {
  private readonly logger = new Logger(MilestonesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly s3: S3Service,
  ) {}

  async findByEngagement(engagementId: string) {
    return this.prisma.milestone.findMany({
      where: { engagementId },
      orderBy: { milestoneIndex: 'asc' },
    });
  }

  async findOne(engagementId: string, milestoneIndex: number) {
    const m = await this.prisma.milestone.findUnique({
      where: { engagementId_milestoneIndex: { engagementId, milestoneIndex } },
    });
    if (!m) throw new NotFoundException(
      `Milestone ${milestoneIndex} not found on engagement ${engagementId}`,
    );
    return m;
  }

  /**
   * Get remaining days until a Locked milestone unlocks.
   * Queries the chain via is_milestone_unlockable() and ledgers_until_unlock().
   */
  async getRetentionTimer(engagementId: string, milestoneIndex: number) {
    const milestone = await this.findOne(engagementId, milestoneIndex);
    const unlockable = await this.stellar.isMilestoneUnlockable(engagementId, milestoneIndex);

    if (unlockable) {
      return { daysRemaining: 0, ledgersRemaining: 0, unlockable: true };
    }

    const ledgersRemaining = await this.stellar.ledgersUntilUnlock(engagementId, milestoneIndex);
    const daysRemaining = this.stellar.ledgersToDays(ledgersRemaining);

    return {
      daysRemaining,
      ledgersRemaining,
      unlockable: false,
      estimatedUnlockAt: milestone.unlockEstimatedAt,
    };
  }

  // ----------------------------------------------------------
  // Core Business/Validation Methods
  // ----------------------------------------------------------

  async getCurrentLedgerSequence(): Promise<number> {
    return this.stellar.getCurrentLedgerSequence();
  }

  async findActiveRetentionMilestones() {
    return this.prisma.milestone.findMany({
      where: {
        kind: 'RETENTION',
        status: MilestoneStatus.LOCKED,
      },
    });
  }

  async unlockRetentionOnChain(milestoneId: string): Promise<void> {
    const milestone = await this.prisma.milestone.findUnique({ where: { id: milestoneId } });
    if (!milestone) return;

    try {
      const txHash = await this.stellar.unlockRetentionMilestone(
        milestone.engagementId,
        milestone.milestoneIndex,
      );

      await this.prisma.milestone.update({
        where: { id: milestoneId },
        data: { status: MilestoneStatus.PENDING },
      });

      await this.prisma.retentionSchedule.updateMany({
        where: {
          engagementId: milestone.engagementId,
          milestoneIndex: milestone.milestoneIndex,
        },
        data: { unlocked: true },
      });
    } catch (error) {
      this.logger.error(`Failed executing on-chain unlock contract validation for milestone ${milestoneId}:`, error);
      throw error;
    }
  }

  async sendRetentionWarningNotification(milestoneId: string): Promise<void> {
    const milestone = await this.prisma.milestone.findUnique({ where: { id: milestoneId } });
    if (!milestone) return;

    this.logger.log(`[Notification Sent] RETENTION_WINDOW_APPROACHING for milestone ${milestoneId}`);

    await this.prisma.milestone.update({
      where: { id: milestoneId },
      data: { approachingNotificationSent: true } as any, // fallback handling if field is implicit
    });

    await this.prisma.retentionSchedule.updateMany({
      where: {
        engagementId: milestone.engagementId,
        milestoneIndex: milestone.milestoneIndex,
      },
      data: { notified: true },
    });
  }

  async confirmMilestone(engagementId: string, milestoneIndex: number) {
    const milestone = await this.findOne(engagementId, milestoneIndex);
    const paymentReleased = BigInt(milestone.amount || 0);
    return this.markConfirmed(engagementId, milestoneIndex, paymentReleased);
  }

  // ----------------------------------------------------------
  // MILESTONE STATE MACHINE TRANSITIONS (Issue #44)
  // ----------------------------------------------------------

  async submitProofFlow(engagementId: string, milestoneIndex: number, proofHash: string) {
    const milestone = await this.findOne(engagementId, milestoneIndex);
    if (milestone.status !== MilestoneStatus.PENDING) {
      throw new UnprocessableEntityException('Milestone must be PENDING to submit proof.');
    }

    const updated = await this.markProofSubmitted(engagementId, milestoneIndex, proofHash);

    const engagement = await this.prisma.engagement.findUnique({ where: { id: engagementId } });
    if (engagement) {
      await this.prisma.notification.create({
        data: {
          userId: engagement.companyId || '', 
          type: 'PROOF_SUBMITTED',
          title: 'Proof Submitted',
          message: `Proof documentation has been submitted for milestone ${milestoneIndex}. Please confirm or dispute.`,
        } as any
      });
    }

    return updated;
  }

  async confirmFlow(engagementId: string, milestoneIndex: number) {
    const milestone = await this.findOne(engagementId, milestoneIndex);
    if (milestone.status !== MilestoneStatus.PROOF_SUBMITTED) {
      throw new UnprocessableEntityException('Milestone proof must be submitted before confirmation.');
    }

    await this.stellar.releaseMilestonePayment(engagementId, milestoneIndex);

    const paymentReleased = BigInt(milestone.amount || 0);
    const updated = await this.markConfirmed(engagementId, milestoneIndex, paymentReleased);

    const engagement = await this.prisma.engagement.findUnique({ where: { id: engagementId } });
    if (engagement) {
      await this.prisma.notification.create({
        data: {
          userId: engagement.recruiterId || '',
          type: 'PAYMENT_RELEASED',
          title: 'Payment Released',
          message: `Payment released for milestone ${milestoneIndex} on engagement ${engagementId}.`,
        } as any
      });
    }

    return updated;
  }

  async disputeFlow(engagementId: string, milestoneIndex: number, reason: string) {
    const milestone = await this.findOne(engagementId, milestoneIndex);
    if (milestone.status !== MilestoneStatus.PROOF_SUBMITTED) {
      throw new UnprocessableEntityException('Can only dispute milestones that have proof submitted.');
    }

    const updated = await this.prisma.milestone.update({
      where: { engagementId_milestoneIndex: { engagementId, milestoneIndex } },
      data: { 
        status: MilestoneStatus.DISPUTED,
        disputeReason: reason,
      } as any,
    });

    const engagement = await this.prisma.engagement.findUnique({ where: { id: engagementId } });
    if (engagement) {
      const targets = [engagement.companyId, engagement.recruiterId, engagement.arbiterId].filter(Boolean);
      for (const target of targets) {
        await this.prisma.notification.create({
          data: {
            userId: target,
            type: 'DISPUTE_RAISED',
            title: 'Dispute Raised',
            message: `A dispute has been raised on milestone ${milestoneIndex}.`,
          } as any
        });
      }
    }

    return updated;
  }

  async resolveDisputeFlow(engagementId: string, milestoneIndex: number, resolution: string) {
    const milestone = await this.findOne(engagementId, milestoneIndex);
    if (milestone.status !== MilestoneStatus.DISPUTED) {
      throw new UnprocessableEntityException('Milestone is not under an active dispute phase.');
    }

    const approved = resolution === 'RELEASE';
    
    await this.stellar.resolveMilestoneDispute(engagementId, milestoneIndex, approved);

    const updated = await this.markResolved(
      engagementId, 
      milestoneIndex, 
      approved, 
      approved ? BigInt(milestone.amount || 0) : undefined
    );

    const engagement = await this.prisma.engagement.findUnique({ where: { id: engagementId } });
    if (engagement) {
      const targets = [engagement.companyId, engagement.recruiterId];
      for (const target of targets) {
        await this.prisma.notification.create({
          data: {
            userId: target,
            type: 'DISPUTE_RESOLVED',
            title: 'Dispute Resolved',
            message: `The milestone ${milestoneIndex} dispute has been resolved: ${resolution}.`,
          } as any
        });
      }
    }

    return updated;
  }

  // ----------------------------------------------------------
  // State update methods — called by EventsService
  // ----------------------------------------------------------

  async markUnlocked(engagementId: string, milestoneIndex: number) {
    return this.prisma.milestone.update({
      where: { engagementId_milestoneIndex: { engagementId, milestoneIndex } },
      data: { status: MilestoneStatus.PENDING },
    });
  }

  async markProofSubmitted(engagementId: string, milestoneIndex: number, proofHash: string) {
    return this.prisma.milestone.update({
      where: { engagementId_milestoneIndex: { engagementId, milestoneIndex } },
      data: { proofHash, status: MilestoneStatus.PROOF_SUBMITTED },
    });
  }

  async markConfirmed(engagementId: string, milestoneIndex: number, paymentReleased: bigint) {
    return this.prisma.milestone.update({
      where: { engagementId_milestoneIndex: { engagementId, milestoneIndex } },
      data: {
        status: MilestoneStatus.CONFIRMED,
        paymentReleased,
        confirmedAt: new Date(),
      },
    });
  }

  async markDisputed(engagementId: string, milestoneIndex: number) {
    return this.prisma.milestone.update({
      where: { engagementId_milestoneIndex: { engagementId, milestoneIndex } },
      data: { status: MilestoneStatus.DISPUTED },
    });
  }

  async markResolved(
    engagementId: string,
    milestoneIndex: number,
    approved: boolean,
    paymentReleased?: bigint,
  ) {
    return this.prisma.milestone.update({
      where: { engagementId_milestoneIndex: { engagementId, milestoneIndex } },
      data: {
        status: approved ? MilestoneStatus.RESOLVED : MilestoneStatus.PENDING,
        ...(approved && paymentReleased ? { paymentReleased, confirmedAt: new Date() } : {}),
      },
    });
  }

  async resolveDispute(engagementId: string, milestoneIndex: number, approved: boolean) {
    return this.markResolved(engagementId, milestoneIndex, approved);
  }

  /**
   * Reset milestones after a replacement is requested.
   * Mirrors what the contract does on-chain: Placement → Pending,
   * unconfirmed Retention milestones → Locked with updated unlock estimates.
   */
  async resetForReplacement(engagementId: string, currentLedger: number) {
    const milestones = await this.findByEngagement(engagementId);

    for (const m of milestones) {
      if (m.kind === 'PLACEMENT') {
        await this.prisma.milestone.update({
          where: { id: m.id },
          data: {
            status: MilestoneStatus.PENDING,
            proofHash: null,
            confirmedAt: null,
            paymentReleased: null,
          },
        });
      } else if (
        m.kind === 'RETENTION' &&
        m.status !== MilestoneStatus.CONFIRMED &&
        m.status !== MilestoneStatus.RESOLVED
      ) {
        const newValidAfterLedger = m.retentionDays
          ? currentLedger + m.retentionDays * 17_280
          : m.validAfterLedger;

        const newUnlockAt = newValidAfterLedger
          ? this.stellar.ledgerToDateTime(newValidAfterLedger, currentLedger)
          : m.unlockEstimatedAt;

        await this.prisma.milestone.update({
          where: { id: m.id },
          data: {
            status: MilestoneStatus.LOCKED,
            proofHash: null,
            validAfterLedger: newValidAfterLedger,
            unlockEstimatedAt: newUnlockAt,
          },
        });

        await this.prisma.retentionSchedule.upsert({
          where: { engagementId_milestoneIndex: { engagementId, milestoneIndex: m.milestoneIndex } },
          create: {
            engagementId,
            milestoneIndex: m.milestoneIndex,
            validAfterLedger: newValidAfterLedger!,
            unlockAt: newUnlockAt!,
            notifyAt: new Date(newUnlockAt!.getTime() - 3 * 24 * 60 * 60 * 1000),
          },
          update: {
            validAfterLedger: newValidAfterLedger!,
            unlockAt: newUnlockAt!,
            notifyAt: new Date(newUnlockAt!.getTime() - 3 * 24 * 60 * 60 * 1000),
            unlocked: false,
            notified: false,
          },
        });
      }
    }
  }

  async uploadDisputeEvidence(
    engagementId: string,
    milestoneIndex: number,
    userId: string,
    file: Express.Multer.File,
  ) {
    const milestone = await this.findOne(engagementId, milestoneIndex);
    if (milestone.status !== MilestoneStatus.DISPUTED) {
      throw new UnprocessableEntityException('Evidence can only be uploaded for disputed milestones.');
    }

    // Validate file type
    const allowedMimeTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new UnprocessableEntityException('Only PDF, PNG, and JPEG files are allowed.');
    }

    // Validate file size (10 MB)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new UnprocessableEntityException('File size must be less than 10 MB.');
    }

    const s3Key = `dispute-evidence/${milestone.id}/${uuidv4()}-${file.originalname}`;
    const s3Path = await this.s3.uploadFile(s3Key, file.buffer, file.mimetype);
    const presignedUrl = await this.s3.getPresignedUrl(s3Path);

    const evidence = await this.prisma.disputeEvidence.create({
      data: {
        milestoneId: milestone.id,
        uploadedBy: userId,
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype,
        s3Path,
        s3Url: presignedUrl,
      },
    });

    return evidence;
  }

  async listDisputeEvidence(
    engagementId: string,
    milestoneIndex: number,
    userId: string,
    userRole: UserRole,
  ) {
    const milestone = await this.findOne(engagementId, milestoneIndex);
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: engagementId },
      include: { company: true, recruiter: true, arbiter: true },
    });

    if (!engagement) {
      throw new NotFoundException('Engagement not found');
    }

    // Check if user is a party or the arbiter (by User.id, since that's what's in the JWT)
    const isParty =
      engagement.company?.id === userId ||
      engagement.recruiter?.id === userId ||
      (userRole === UserRole.ARBITER && engagement.arbiter?.id === userId);

    if (!isParty) {
      throw new ForbiddenException('Only parties and the assigned arbiter can view dispute evidence.');
    }

    const evidenceList = await this.prisma.disputeEvidence.findMany({
      where: { milestoneId: milestone.id },
      orderBy: { uploadedAt: 'desc' },
      include: { user: { select: { id: true, name: true, role: true } } },
    });

    // Generate presigned URLs for each file
    const evidenceWithUrls = await Promise.all(
      evidenceList.map(async (evidence) => {
        const url = await this.s3.getPresignedUrl(evidence.s3Path);
        return {
          ...evidence,
          s3Url: url,
        };
      }),
    );

    return evidenceWithUrls;
  }
}
