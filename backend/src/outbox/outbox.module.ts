import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

@Module({
	imports: [QueueModule],
	providers: [OutboxDispatcherService],
	exports: [OutboxDispatcherService],
})
export class OutboxModule {}
