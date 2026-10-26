import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CreateDraftDto } from './create-draft.dto';
import { DraftsService } from './drafts.service';
import { requireOwner } from './owner';

@Controller('v1/drafts')
export class DraftsController {
  constructor(private readonly drafts: DraftsService) {}

  @Post()
  @HttpCode(201)
  create(@Headers('x-owner-id') ownerId: string | undefined, @Body() dto: CreateDraftDto) {
    return this.drafts.create(requireOwner(ownerId), dto.document ?? { elements: [] });
  }

  @Get()
  list(@Headers('x-owner-id') ownerId: string | undefined, @Query('status') status?: string) {
    return this.drafts.list(requireOwner(ownerId), status);
  }

  @Get(':draftId')
  get(@Headers('x-owner-id') ownerId: string | undefined, @Param('draftId', new ParseUUIDPipe()) draftId: string) {
    return this.drafts.get(requireOwner(ownerId), draftId);
  }
}
