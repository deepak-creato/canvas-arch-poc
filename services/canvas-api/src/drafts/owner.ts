import { BadRequestException } from '@nestjs/common';

export function requireOwner(ownerId: string | undefined): string {
  if (!ownerId?.trim()) throw new BadRequestException({ code: 'OWNER_REQUIRED', message: 'X-Owner-Id header required' });
  return ownerId.trim();
}
