export type SupportedAIProvider = 'GEMINI' | 'OPENROUTER' | 'XKIRO';

export type AIModelSource = 'DYNAMIC' | 'CURATED_FALLBACK';

export interface AIModel {
  id: string;
  name: string;
  description?: string | undefined;
  contextLength?: number | undefined;
  isFree?: boolean | undefined;
  provider: SupportedAIProvider;
  source?: AIModelSource | undefined;
  isFallback?: boolean | undefined;
}

export interface AITextRequest {
  systemPrompt?: string | undefined;
  userPrompt: string;
  model?: string | undefined;
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
}

export interface AITextResponse {
  provider: SupportedAIProvider;
  model: string;
  text: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  requestId?: string | undefined;
  latencyMs: number;
  finishReason?: string | undefined;
}

export interface AIConnectionResult {
  connected: boolean;
  provider: SupportedAIProvider;
  keyLast4: string;
  selectedModel?: string | undefined;
  models?: AIModel[] | undefined;
  latencyMs?: number | undefined;
  error?: string | undefined;
}

export interface AIProvider {
  readonly providerName: SupportedAIProvider;
  generateText(request: AITextRequest): Promise<AITextResponse>;
  listModels?(): Promise<AIModel[]>;
  testConnection?(): Promise<AIConnectionResult>;
}

export interface UserAIProviderStatus {
  configured: boolean;
  keyLast4: string | null;
  provider: SupportedAIProvider;
  selectedModel: string | null;
  isActive: boolean;
  lastUsedAt: string | null;
  usageToday: number;
}
