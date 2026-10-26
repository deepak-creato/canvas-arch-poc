import { IsInt, IsObject, Min } from 'class-validator';

export class SaveDraftDto {
  // Head revision the client edited from. A stale value returns 409 REVISION_CONFLICT.
  @IsInt()
  @Min(1)
  base_revision!: number;

  @IsObject()
  document!: Record<string, unknown>;
}
