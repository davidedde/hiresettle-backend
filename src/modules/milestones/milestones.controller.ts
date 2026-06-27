import { Controller, Get, Param, ParseIntPipe, UseGuards, Patch, UnprocessableEntityException, Post, UseInterceptors, UploadedFile, ForbiddenException, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { MilestonesService } from './milestones.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { Throttle } from '@nestjs/throttler';
import { UserJwtSubThrottlerGuard } from '../../common/guards/user-jwt-sub-throttler.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

@ApiTags('milestones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@UseGuards(UserJwtSubThrottlerGuard)
@Throttle({ limit: 100, ttl: 60 })
@Controller('engagements/:engagementId/milestones')
export class MilestonesController {

  constructor(private readonly milestonesService: MilestonesService) { }

  @Get()
  @ApiOperation({ summary: 'List all milestones for an engagement' })
  findAll(@Param('engagementId') engagementId: string) {
    return this.milestonesService.findByEngagement(engagementId);
  }

  @Get(':index')
  @ApiOperation({ summary: 'Get a single milestone by index' })
  findOne(
    @Param('engagementId') engagementId: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.milestonesService.findOne(engagementId, index);
  }

  @Get(':index/timer')
  @ApiOperation({ summary: 'Get retention countdown timer for a Locked milestone' })
  getTimer(
    @Param('engagementId') engagementId: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.milestonesService.getRetentionTimer(engagementId, index);
  }

  @Post(':index/resolve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ARBITER)
  @ApiOperation({ summary: 'Resolve a dispute on a milestone (arbiter only)' })
  resolveDispute(
    @Param('engagementId') engagementId: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: ResolveDisputeDto,
    @CurrentUser() user: any,
  ) {
    return this.milestonesService.resolveDisputeFlow(engagementId, index, dto.resolution);
  }

  @Post(':index/dispute-evidence')
  @ApiOperation({ summary: 'Upload dispute evidence file' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadEvidence(
    @Param('engagementId') engagementId: string,
    @Param('index', ParseIntPipe) index: number,
    @CurrentUser() user: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.milestonesService.uploadDisputeEvidence(
      engagementId,
      index,
      user.id,
      file,
    );
  }

  @Get(':index/dispute-evidence')
  @ApiOperation({ summary: 'List dispute evidence files' })
  async listEvidence(
    @Param('engagementId') engagementId: string,
    @Param('index', ParseIntPipe) index: number,
    @CurrentUser() user: any,
  ) {
    return this.milestonesService.listDisputeEvidence(
      engagementId,
      index,
      user.id,
      user.role,
    );
  }
}
