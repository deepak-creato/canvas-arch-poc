import { randomUUID } from 'crypto';
import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { requireOwner } from '../drafts/owner';
import { AiService } from './ai.service';
import { CreateAiLayoutDto } from './create-ai-layout.dto';

@Controller('v1')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('drafts/:draftId/ai-layouts')
  @HttpCode(202)
  request(
    @Headers('x-owner-id') ownerId: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
    @Body() dto: CreateAiLayoutDto,
  ) {
    return this.ai.request(requireOwner(ownerId), draftId, dto, correlationId ?? randomUUID());
  }

  @Get('ai-layouts/:generationId')
  get(@Headers('x-owner-id') ownerId: string | undefined, @Param('generationId', new ParseUUIDPipe()) generationId: string) {
    return this.ai.get(requireOwner(ownerId), generationId);
  }
}
