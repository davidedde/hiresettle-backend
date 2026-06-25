import {
  Controller, Get, Post, Body, Param,
  Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
  ApiTags, ApiOperation, ApiResponse,
  ApiBearerAuth, ApiQuery,
} from '@nestjs/swagger';
import { EngagementsService } from './engagements.service';
import { CreateEngagementDto } from './dto/create-engagement.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { EngagementStatus } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { UserJwtSubThrottlerGuard } from '../../common/guards/user-jwt-sub-throttler.guard';

@ApiTags('engagements')
@ApiBearerAuth()
@UseGuards(UserJwtSubThrottlerGuard)
@UseGuards(JwtAuthGuard)
@Throttle({ limit: 100, ttl: 60 })
@Controller('engagements')
export class EngagementsController {
  constructor(private readonly engagementsService: EngagementsService) { }

  /**
   * POST /api/v1/engagements
   * Called by the frontend after the company has signed and broadcast
   * the create_engagement tx via Freighter.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(UserRole.COMPANY)
  @ApiOperation({ summary: 'Register a newly created on-chain engagement' })
  create(@Body() dto: CreateEngagementDto) {
    return this.engagementsService.create(dto);
  }

  /**
   * GET /api/v1/engagements
   * List with optional filters. Company sees their posted roles.
   * Recruiter sees their assigned engagements.
   */
  @Get()
  @ApiOperation({ summary: 'List engagements with filters and pagination' })
  @ApiQuery({ name: 'companyAddress', required: false })
  @ApiQuery({ name: 'recruiterAddress', required: false })
  @ApiQuery({ name: 'status', required: false, enum: EngagementStatus })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @Query('companyAddress') companyAddress?: string,
    @Query('recruiterAddress') recruiterAddress?: string,
    @Query('status') status?: EngagementStatus,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.engagementsService.findAll({ companyAddress, recruiterAddress, status, page, limit });
  }

  /**
   * GET /api/v1/engagements/:id
   * Full detail — milestones, events, retention schedule.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get full engagement details' })
  @ApiResponse({ status: 404, description: 'Engagement not found' })
  findOne(@Param('id') id: string) {
    return this.engagementsService.findOne(id);
  }

  /**
   * POST /api/v1/engagements/:id/sync
   * Force re-read the engagement from the Stellar chain.
   */
  @Post(':id/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force sync engagement status from Stellar chain' })
  sync(@Param('id') id: string) {
    return this.engagementsService.syncFromChain(id);
  }
}
