/** A step failure the workflow should see: sent as SendTaskFailure with `code` as the error name. */
export class StepError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
