import { Module } from '@nestjs/common';
import { createPool } from '../../shared/db';
import { createSfn } from '../../shared/sfn';
import { createSqs } from '../../shared/sqs';
import { createPresignS3, createS3 } from '../../shared/s3';
import { HealthController } from './health.controller';
import { AiController } from './ai/ai.controller';
import { AiService } from './ai/ai.service';
import { PublishOrchestrator } from './publish/orchestrator';
import { PublishSteps } from './publish/steps';
import { StepRunner } from './publish/step-runner';
import { PG_POOL, PRESIGN_S3, S3, SFN, SQS } from './tokens';
import { AssetsController } from './assets/assets.controller';
import { AssetsService } from './assets/assets.service';
import { DraftsController } from './drafts/drafts.controller';
import { DraftsService } from './drafts/drafts.service';
import { CompleteService } from './uploads/complete.service';
import { UploadsController } from './uploads/uploads.controller';
import { UploadsService } from './uploads/uploads.service';

@Module({
  controllers: [HealthController, UploadsController, AssetsController, DraftsController, AiController],
  providers: [
    UploadsService,
    CompleteService,
    AssetsService,
    DraftsService,
    AiService,
    PublishSteps,
    StepRunner,
    PublishOrchestrator,
    { provide: PG_POOL, useFactory: createPool },
    { provide: PRESIGN_S3, useFactory: createPresignS3 },
    { provide: S3, useFactory: createS3 },
    { provide: SQS, useFactory: createSqs },
    { provide: SFN, useFactory: createSfn },
  ],
})
export class AppModule {}
