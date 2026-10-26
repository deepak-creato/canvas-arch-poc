import { Module } from '@nestjs/common';
import { createPool } from '../../shared/db';
import { createPresignS3, createS3 } from '../../shared/s3';
import { HealthController } from './health.controller';
import { PG_POOL, PRESIGN_S3, S3 } from './tokens';
import { AssetsController } from './assets/assets.controller';
import { AssetsService } from './assets/assets.service';
import { CompleteService } from './uploads/complete.service';
import { UploadsController } from './uploads/uploads.controller';
import { UploadsService } from './uploads/uploads.service';

@Module({
  controllers: [HealthController, UploadsController, AssetsController],
  providers: [
    UploadsService,
    CompleteService,
    AssetsService,
    { provide: PG_POOL, useFactory: createPool },
    { provide: PRESIGN_S3, useFactory: createPresignS3 },
    { provide: S3, useFactory: createS3 },
  ],
})
export class AppModule {}
