import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

export class CreatePublicationDto {
  // The exact revision to publish. The snapshot is pinned; later edits cannot change it.
  @IsInt()
  @Min(1)
  revision!: number;

  // Local POC only: failure injection for the mock transcoder ("permanent" or "transient:N").
  // Ignored unless WORKER_TEST_HOOKS=true.
  @IsOptional()
  @IsString()
  @Matches(/^(permanent|transient:\d+)$/)
  test_fail_mode?: string;
}
