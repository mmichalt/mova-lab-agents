export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly workflowId: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    extras?: { retryable?: boolean; retryAfterMs?: number; workflowId?: string },
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.retryable = extras?.retryable === true;
    this.retryAfterMs = extras?.retryAfterMs;
    this.workflowId = extras?.workflowId;
  }
}
