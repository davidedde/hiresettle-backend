import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { RetentionSchedulerService } from './retention-scheduler.service';
import { MilestonesModule } from '../milestones/milestones.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EngagementsModule } from '../engagements/engagements.module';

@Module({
  imports: [MilestonesModule, NotificationsModule, EngagementsModule],
  providers: [EventsService, RetentionSchedulerService],
  controllers: [EventsController],
})
export class EventsModule {}
