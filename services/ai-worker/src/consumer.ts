import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { log } from '../../shared/log';
import { handleMessage } from './handler';

const RETRY_DELAY_SECONDS = 2;

export class Consumer {
  private running = true;
  private loop?: Promise<void>;

  constructor(
    private readonly pool: Pool,
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
    const url = config.queueAiRequestsUrl;
    log('info', 'ai consumer started', { queue: url });
    while (this.running) {
      try {
        const out = await this.sqs.send(
          new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 5, WaitTimeSeconds: 5, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }),
        );
        await Promise.all(
          (out.Messages ?? []).map(async (m) => {
            const receives = Number(m.Attributes?.ApproximateReceiveCount ?? 1);
            try {
              const outcome = await handleMessage(this.pool, m.Body ?? '', m.MessageId ?? '', receives, config.sqsMaxReceiveCount);
              if (outcome === 'ack') await this.sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle! }));
              else await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: RETRY_DELAY_SECONDS }));
            } catch (e) {
              // e.g. database down: leave the message, SQS redelivers it.
              log('error', 'ai handler failed, will be redelivered', { correlation_id: m.MessageId, receives, error: String(e) });
            }
          }),
        );
      } catch (e) {
        log('error', 'poll failed', { error: String(e) });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    log('info', 'ai consumer stopped');
  }
}
