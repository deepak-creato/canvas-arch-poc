import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { config } from '../../shared/config';
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
          new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 5, WaitTimeSeconds: 5 }),
        );
        await Promise.all((out.Messages ?? []).map((m) => this.process(url, m.MessageId ?? '', m.Body ?? '', m.ReceiptHandle!)));
      } catch (e) {
        log('error', 'poll failed', { error: String(e) });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    log('info', 'consumer stopped');
  }

  private async process(url: string, id: string, body: string, receipt: string) {
    try {
      const outcome = await handleMessage(this.pool, this.s3, body, id);
      if (outcome === 'ack') {
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receipt }));
      }
    } catch (e) {
      // Transient failure: leave the message; SQS redelivers it after the visibility timeout.
      log('error', 'handler failed, will be redelivered', { correlation_id: id, error: String(e) });
    }
  }
}
