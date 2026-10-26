import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { Inject, Injectable } from '@nestjs/common';
import { config } from '../../../shared/config';
import { log } from '../../../shared/log';
import { SFN } from '../tokens';

/** Starts the publish state machine. The execution name is fixed per publication and attempt, so a repeated start is harmless. */
@Injectable()
export class PublishOrchestrator {
  constructor(@Inject(SFN) private readonly sfn: SFNClient) {}

  async start(publicationId: string, attempt: number): Promise<string> {
    const name = `${publicationId}-a${attempt}`;
    const input = {
      publication_id: publicationId,
      attempt,
      validation: { iteration: 0 },
      wait_seconds: config.publishWaitSeconds,
      canvas_timeout_seconds: config.publishCanvasTimeoutSeconds,
      transcode_timeout_seconds: config.publishTranscodeTimeoutSeconds,
    };
    try {
      const out = await this.sfn.send(new StartExecutionCommand({ stateMachineArn: config.publishStateMachineArn, name, input: JSON.stringify(input) }));
      log('info', 'publish execution started', { publication_id: publicationId, attempt, execution_arn: out.executionArn });
      return out.executionArn!;
    } catch (e: any) {
      // Same name and same input: Step Functions answers ExecutionAlreadyExists, which means it is already running.
      if (e?.name === 'ExecutionAlreadyExists') {
        const arn = `${config.publishStateMachineArn.replace(':stateMachine:', ':execution:')}:${name}`;
        log('info', 'publish execution already exists', { publication_id: publicationId, attempt, execution_arn: arn });
        return arn;
      }
      throw e;
    }
  }
}
