import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class CanvasSizeDto {
  @IsInt()
  @Min(64)
  @Max(4096)
  width!: number;

  @IsInt()
  @Min(64)
  @Max(4096)
  height!: number;
}

export class CreateAiLayoutDto {
  // Order matters: it is part of the cache identity.
  @IsUUID('all', { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  asset_ids!: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CanvasSizeDto)
  canvas?: CanvasSizeDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  seed?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  model_version?: string;

  // Failure injection for tests; the worker only honors it when WORKER_TEST_HOOKS=true.
  @IsOptional()
  @IsIn(['permanent', 'transient_once'])
  test_fail?: 'permanent' | 'transient_once';
}
