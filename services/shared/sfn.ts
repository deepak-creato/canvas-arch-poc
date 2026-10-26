import { SFNClient, SendTaskFailureCommand, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { config } from './config';
import { log, LogFields } from './log';

export const createSfn = () => new SFNClient({ region: config.region, endpoint: config.s3Endpoint });

// The token is gone: the step timed out, the execution ended, or it was answered already.
// Retrying cannot help, so callers drop the message.
const TOKEN_GONE = new Set(['TaskDoesNotExist', 'InvalidToken', 'TaskTimedOut']);

/** Answers a task token. Returns false when the token no longer exists; throws on other errors so the message is redelivered. */
export async function answerTask(
  sfn: SFNClient,
  token: string,
  result: { ok: true; output: unknown } | { ok: false; error: string; cause: string },
  ctx: LogFields = {},
): Promise<boolean> {
  try {
    if (result.ok) {
      await sfn.send(new SendTaskSuccessCommand({ taskToken: token, output: JSON.stringify(result.output) }));
    } else {
      await sfn.send(new SendTaskFailureCommand({ taskToken: token, error: result.error, cause: result.cause.slice(0, 500) }));
    }
    return true;
  } catch (e: any) {
    if (TOKEN_GONE.has(e?.name)) {
      log('warn', 'task token no longer valid, dropping answer', { ...ctx, error: e.name });
      return false;
    }
    throw e;
  }
}
