import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { backoffSeconds, PermanentError } from '../../shared/job-repo';
import { log } from '../../shared/log';
import { handleMessage } from './handler';

export class Consumer {
  private running = true;
  private loop?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly s3: S3Client,
    private readonly sqs: SQSClient,
  ) {}

  start() {
    this.loop = this.run();
  }

  /** Stops polling and waits for in-flight messages. */
  async stop() {
    this.running = false;
    await this.loop;
  }

  private async run() {
    const url = config.queueLightProcessingUrl;
    log('info', 'consumer started', { queue: url });
    while (this.running) {
      try {
        const out = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: 5,
            WaitTimeSeconds: 5,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );
        await Promise.all((out.Messages ?? []).map((m) => this.process(url, m.MessageId ?? '', m.Body ?? '', m.ReceiptHandle!, Number(m.Attributes?.ApproximateReceiveCount ?? 1))));
      } catch (e) {
        log('error', 'poll failed', { error: String(e) });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    log('info', 'consumer stopped');
  }

  private async process(url: string, id: string, body: string, receipt: string, receives: number) {
    // Seconds until SQS shows the message again. Failed work waits out the job's backoff (+1s margin).
    const hideFor = async (seconds: number) =>
      this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: receipt, VisibilityTimeout: seconds }));
    try {
      const outcome = await handleMessage(this.pool, this.s3, body, id);
      if (outcome === 'ack') await this.sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receipt }));
      else if (outcome === 'dead') await hideFor(0);
      else await hideFor(backoffSeconds(receives) + 1);
    } catch (e) {
      log('error', 'handler failed, will be redelivered', { correlation_id: id, receives, error: String(e) });
      try {
        // A permanent failure should reach the DLQ quickly; anything else backs off.
        await hideFor(e instanceof PermanentError ? 0 : backoffSeconds(receives) + 1);
      } catch (e2) {
        log('warn', 'could not change message visibility', { correlation_id: id, error: String(e2) });
      }
    }
  }
}
