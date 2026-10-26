import { SQSClient } from '@aws-sdk/client-sqs';
import { config } from './config';

export const createSqs = () => new SQSClient({ region: config.region, endpoint: config.s3Endpoint });
