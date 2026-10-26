import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { CreateDraftDto } from './create-draft.dto';
import { SaveDraftDto } from './save-draft.dto';
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

  @Put(':draftId')
  save(
    @Headers('x-owner-id') ownerId: string | undefined,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
    @Body() dto: SaveDraftDto,
  ) {
    return this.drafts.save(requireOwner(ownerId), draftId, dto.base_revision, dto.document);
  }

  @Get(':draftId/revisions')
  revisions(@Headers('x-owner-id') ownerId: string | undefined, @Param('draftId', new ParseUUIDPipe()) draftId: string) {
    return this.drafts.revisions(requireOwner(ownerId), draftId);
  }

  @Post(':draftId/revisions/:rev/restore')
  @HttpCode(200)
  restoreRevision(
    @Headers('x-owner-id') ownerId: string | undefined,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
    @Param('rev', ParseIntPipe) rev: number,
  ) {
    return this.drafts.restoreRevision(requireOwner(ownerId), draftId, rev);
  }

  @Delete(':draftId')
  discard(@Headers('x-owner-id') ownerId: string | undefined, @Param('draftId', new ParseUUIDPipe()) draftId: string) {
    return this.drafts.discard(requireOwner(ownerId), draftId);
  }

  @Post(':draftId/restore')
  @HttpCode(200)
  restore(@Headers('x-owner-id') ownerId: string | undefined, @Param('draftId', new ParseUUIDPipe()) draftId: string) {
    return this.drafts.restore(requireOwner(ownerId), draftId);
  }
}
