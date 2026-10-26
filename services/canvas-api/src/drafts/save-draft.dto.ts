import { IsInt, IsObject, Min } from 'class-validator';

export class SaveDraftDto {
  // Head revision the client edited from. Enforced by POC-016.
  @IsInt()
  @Min(1)
  base_revision!: number;

  @IsObject()
  document!: Record<string, unknown>;
}
