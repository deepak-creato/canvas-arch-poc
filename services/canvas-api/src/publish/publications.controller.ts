import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { requireOwner } from '../drafts/owner';
import { CreatePublicationDto } from './create-publication.dto';
import { PublicationsService } from './publications.service';

@Controller('v1')
export class PublicationsController {
  constructor(private readonly publications: PublicationsService) {}

  @Post('drafts/:draftId/publications')
  @HttpCode(202)
  async create(
    @Res({ passthrough: true }) res: { status(code: number): unknown },
    @Headers('x-owner-id') ownerId: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
    @Body() dto: CreatePublicationDto,
  ) {
    const pub = await this.publications.create(requireOwner(ownerId), draftId, key, dto);
    // A repeat of an accepted request returns the same operation: 200 instead of 202.
    if (pub.idempotent_replay) res.status(200);
    return pub;
  }

  @Get('publications/:publicationId')
  get(@Headers('x-owner-id') ownerId: string | undefined, @Param('publicationId', new ParseUUIDPipe()) publicationId: string) {
    return this.publications.get(requireOwner(ownerId), publicationId);
  }
}
