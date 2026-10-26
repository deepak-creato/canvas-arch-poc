import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { ALLOWED_CONTENT_TYPES } from '../../../shared/config';

export class CreateUploadDto {
  @Matches(/^[a-f0-9]{64}$/, { message: 'sha256 must be 64 lowercase hex characters' })
  sha256: string;

  @IsIn(Object.keys(ALLOWED_CONTENT_TYPES))
  content_type: string;

  @IsInt()
  @Min(1)
  size_bytes: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}
