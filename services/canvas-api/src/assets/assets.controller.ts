import { BadRequestException, Controller, Get, Headers, Param, ParseUUIDPipe } from '@nestjs/common';
import { AssetsService } from './assets.service';

@Controller('v1/assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get(':assetId')
  get(
    @Headers('x-owner-id') ownerId: string | undefined,
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
  ) {
    if (!ownerId?.trim()) throw new BadRequestException({ code: 'OWNER_REQUIRED', message: 'X-Owner-Id header required' });
    return this.assets.get(ownerId.trim(), assetId);
  }
}
