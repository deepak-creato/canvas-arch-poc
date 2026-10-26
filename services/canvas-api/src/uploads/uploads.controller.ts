import { randomUUID } from 'crypto';
import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post, BadRequestException } from '@nestjs/common';
import { CreateUploadDto } from './create-upload.dto';
import { CompleteService } from './complete.service';
import { UploadsService } from './uploads.service';

@Controller('v1/uploads')
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly completion: CompleteService,
  ) {}

  @Post()
  @HttpCode(200)
  create(
    @Headers('x-owner-id') ownerId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() dto: CreateUploadDto,
  ) {
    if (!ownerId?.trim()) throw new BadRequestException({ code: 'OWNER_REQUIRED', message: 'X-Owner-Id header required' });
    return this.uploads.createUpload(ownerId.trim(), dto, correlationId ?? randomUUID());
  }

  @Post(':assetId/complete')
  @HttpCode(200)
  complete(
    @Headers('x-owner-id') ownerId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
  ) {
    if (!ownerId?.trim()) throw new BadRequestException({ code: 'OWNER_REQUIRED', message: 'X-Owner-Id header required' });
    return this.completion.complete(ownerId.trim(), assetId, correlationId ?? randomUUID());
  }
}
