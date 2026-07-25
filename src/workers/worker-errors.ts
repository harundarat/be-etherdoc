export class RetryableJobError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = RetryableJobError.name;
  }
}

export class TerminalJobError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = TerminalJobError.name;
  }
}
