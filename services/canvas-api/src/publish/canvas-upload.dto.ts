import { IsIn, IsInt, Min } from 'class-validator';

export const CANVAS_TYPES: Record<string, string> = { 'image/png': 'png', 'video/mp4': 'mp4' };

export class CanvasUploadDto {
  @IsIn(Object.keys(CANVAS_TYPES))
  content_type!: string;

  @IsInt()
  @Min(1)
  size_bytes!: number;
}

export class CanvasUploadedDto {
  @IsIn(Object.keys(CANVAS_TYPES))
  content_type!: string;
}
