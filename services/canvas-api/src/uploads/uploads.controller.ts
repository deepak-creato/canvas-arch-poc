import { randomUUID } from 'crypto';
import { Body, Controller, Headers, HttpCode, Post, BadRequestException } from '@nestjs/common';
import { CreateUploadDto } from './create-upload.dto';
import { UploadsService } from './uploads.service';

@Controller('v1/uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

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
}
