export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    extras?: { retryable?: boolean; retryAfterMs?: number },
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.retryable = extras?.retryable === true;
    this.retryAfterMs = extras?.retryAfterMs;
  }
}
