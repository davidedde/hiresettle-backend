import { Controller, Get, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MilestonesService } from './milestones.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('milestones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('engagements/:engagementId/milestones')
export class MilestonesController {
  constructor(private readonly milestonesService: MilestonesService) {}

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
}
