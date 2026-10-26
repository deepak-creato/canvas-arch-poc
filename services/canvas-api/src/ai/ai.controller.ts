import { randomUUID } from 'crypto';
import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { requireOwner } from '../drafts/owner';
import { AiService } from './ai.service';
import { AcceptAiLayoutDto, CreateAiLayoutDto } from './create-ai-layout.dto';

@Controller('v1')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('drafts/:draftId/ai-layouts')
  @HttpCode(202)
  async request(
    @Res({ passthrough: true }) res: { status(code: number): unknown },
    @Headers('x-owner-id') ownerId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
    @Body() dto: CreateAiLayoutDto,
  ) {
    const gen = await this.ai.request(requireOwner(ownerId), draftId, dto, correlationId ?? randomUUID());
    // A cache hit is already finished: 200 instead of 202.
    if (gen.cached) res.status(200);
    return gen;
  }

  @Post('drafts/:draftId/ai-layouts/:generationId/accept')
  @HttpCode(200)
  accept(
    @Headers('x-owner-id') ownerId: string | undefined,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
    @Param('generationId', new ParseUUIDPipe()) generationId: string,
    @Body() dto: AcceptAiLayoutDto,
  ) {
    return this.ai.accept(requireOwner(ownerId), draftId, generationId, dto.base_revision);
  }

  @Get('ai-layouts/:generationId')
  get(@Headers('x-owner-id') ownerId: string | undefined, @Param('generationId', new ParseUUIDPipe()) generationId: string) {
    return this.ai.get(requireOwner(ownerId), generationId);
  }
}
