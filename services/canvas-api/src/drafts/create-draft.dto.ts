import { IsObject, IsOptional } from 'class-validator';

export class CreateDraftDto {
  // Starting canvas document. Defaults to an empty canvas.
  @IsOptional()
  @IsObject()
  document?: Record<string, unknown>;
}
