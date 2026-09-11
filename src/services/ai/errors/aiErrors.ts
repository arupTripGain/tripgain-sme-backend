export type AIErrorCode =
  | 'AI_PROVIDER_NOT_CONFIGURED'
  | 'AI_INVALID_API_KEY'
  | 'AI_RATE_LIMITED'
  | 'AI_QUOTA_EXCEEDED'
  | 'AI_MODEL_NOT_FOUND'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_REQUEST_TIMEOUT'
  | 'AI_INVALID_RESPONSE'
  | 'AI_CONTENT_FILTERED'
  | 'AI_UNKNOWN_ERROR'
  | 'AI_PROVIDER_AUTH_FAILED'
  | 'AI_USAGE_LIMIT_REACHED';

export class AIProviderError extends Error {
  code: AIErrorCode;
  status: number;
  provider?: string | undefined;
  retryAfterSeconds?: number | undefined;

  constructor(
    code: AIErrorCode,
    message: string,
    status: number = 400,
    provider?: string | undefined,
    retryAfterSeconds?: number | undefined
  ) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.status = status;
    this.provider = provider;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
