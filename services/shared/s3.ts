import { S3Client } from '@aws-sdk/client-s3';
import { config } from './config';

const base = { region: config.region, forcePathStyle: true };

// Server-side calls use the in-network endpoint.
export const createS3 = () => new S3Client({ ...base, endpoint: config.s3Endpoint });

// Presigned URLs are used by the host/browser, so they are signed against the public endpoint.
export const createPresignS3 = () => new S3Client({ ...base, endpoint: config.s3PublicEndpoint });
