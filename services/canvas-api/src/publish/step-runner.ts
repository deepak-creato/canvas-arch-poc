import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SFNClient } from '@aws-sdk/client-sfn';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { config } from '../../../shared/config';
import { log } from '../../../shared/log';
import { answerTask } from '../../../shared/sfn';
import { SFN, SQS } from '../tokens';
import { StepError } from './errors';
import { HOLD, PublishSteps, StepMessage } from './steps';

const RETRY_DELAY_SECONDS = 2;

/**
 * Consumes the publish-tasks queue. Step Functions puts one message per workflow step there
 * (waitForTaskToken); this runner does the step and answers the token. A StepError answers with a
 * failure the state machine can catch. Any other error leaves the message for SQS to redeliver, and
 * on the last delivery answers with a failure, so a publication never waits on a message that ends in the DLQ.
 */
@Injectable()
export class StepRunner implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly steps: PublishSteps,
    @Inject(SQS) private readonly sqs: SQSClient,
    @Inject(SFN) private readonly sfn: SFNClient,
  ) {}

  onModuleInit() {
    if (process.env.PUBLISH_RUNNER === 'off') return;
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy() {
    this.running = false;
    await this.loop;
  }

  private async run() {
    const url = config.queuePublishTasksUrl;
    log('info', 'publish step runner started', { queue: url });
    while (this.running) {
      try {
        const out = await this.sqs.send(
          new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 5, WaitTimeSeconds: 5, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }),
        );
        await Promise.all((out.Messages ?? []).map((m) => this.handle(url, m)));
      } catch (e) {
        log('error', 'publish queue poll failed', { error: String(e) });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    log('info', 'publish step runner stopped');
  }

  private async handle(url: string, m: { Body?: string; MessageId?: string; ReceiptHandle?: string; Attributes?: Record<string, string> }) {
    const receives = Number(m.Attributes?.ApproximateReceiveCount ?? 1);
    const ack = () => this.sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle! }));
    const msg = parse(m.Body);
    if (!msg) {
      log('error', 'unparseable publish task, leaving for DLQ', { correlation_id: m.MessageId });
      await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: 0 }));
      return;
    }
    const ctx = { publication_id: msg.publication_id, step: msg.step, correlation_id: m.MessageId };
    try {
      const out = await this.steps.run(msg);
      if (out !== HOLD) await answerTask(this.sfn, msg.token, { ok: true, output: out }, ctx);
      await ack();
      log('info', out === HOLD ? 'step holding for external answer' : 'step done', ctx);
    } catch (e) {
      try {
        if (e instanceof StepError) {
          log('warn', 'step failed', { ...ctx, code: e.code, error: e.message });
          await answerTask(this.sfn, msg.token, { ok: false, error: e.code, cause: e.message }, ctx);
          await ack();
        } else if (receives >= config.sqsMaxReceiveCount) {
          log('error', 'step failed on last delivery', { ...ctx, error: String(e) });
          await answerTask(this.sfn, msg.token, { ok: false, error: 'STEP_ERROR', cause: String(e) }, ctx);
          await ack();
        } else {
          log('warn', 'step failed, will be redelivered', { ...ctx, receives, error: String(e) });
          await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: RETRY_DELAY_SECONDS }));
        }
      } catch (inner) {
        // e.g. Step Functions unreachable: leave the message, SQS redelivers it.
        log('error', 'could not answer task, will be redelivered', { ...ctx, error: String(inner) });
      }
    }
  }
}

function parse(body?: string): StepMessage | null {
  try {
    const r = JSON.parse(body ?? '');
    if (r && typeof r.step === 'string' && typeof r.publication_id === 'string' && typeof r.token === 'string') return r;
  } catch {
    /* fall through */
  }
  return null;
}
