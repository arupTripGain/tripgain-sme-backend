import {
  AIProvider,
  AITextRequest,
  AITextResponse,
  AIModel,
  AIConnectionResult,
  SupportedAIProvider
} from '../types/ai';
import { AIProviderError } from '../errors/aiErrors';

export class XKiroProvider implements AIProvider {
  readonly providerName: SupportedAIProvider = 'XKIRO';
  private apiKey: string;
  private keyLast4: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey.trim();
    this.keyLast4 = this.apiKey.length >= 4 ? this.apiKey.slice(-4) : '****';
    const targetUrl = baseUrl || process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1';
    this.baseUrl = targetUrl.replace(/\/+$/, '');
  }

  async generateText(request: AITextRequest): Promise<AITextResponse> {
    const startTime = performance.now();
    const model = request.model || 'qwen/qwen3.5-flash:free';

    const messages = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.userPrompt });

    const payload = {
      model,
      messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxOutputTokens ?? 2048
    };

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const latencyMs = Math.round(performance.now() - startTime);

      if (!res.ok) {
        const errorBody = await res.text();
        const retryAfter = res.headers.get('retry-after');
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
        throw this.normalizeHttpError(res.status, errorBody, model, retryAfterSeconds);
      }

      const data = await res.json();
      const choice = data.choices?.[0];
      const text = choice?.message?.content || '';
      const finishReason = choice?.finish_reason || 'stop';

      const usage = data.usage;
      const inputTokens = usage?.prompt_tokens;
      const outputTokens = usage?.completion_tokens;
      const totalTokens = usage?.total_tokens;

      return {
        provider: 'XKIRO',
        model: data.model || model,
        text,
        inputTokens,
        outputTokens,
        totalTokens,
        requestId: data.id,
        latencyMs,
        finishReason
      };
    } catch (err: any) {
      if (err instanceof AIProviderError) throw err;
      throw this.normalizeNetworkError(err);
    }
  }

  async listModels(): Promise<AIModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      if (!res.ok) {
        return this.getDefaultModels();
      }

      const json = await res.json();
      const rawList: any[] = json.data || [];

      if (!Array.isArray(rawList) || rawList.length === 0) {
        return this.getDefaultModels();
      }

      return rawList.map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        description: m.description || `xKiro ${m.id} model`,
        contextLength: m.context_length || 64000,
        isFree: m.id?.includes(':free') || false,
        provider: 'XKIRO' as SupportedAIProvider,
        source: 'DYNAMIC',
        isFallback: false
      }));
    } catch (_) {
      return this.getDefaultModels();
    }
  }

  async testConnection(): Promise<AIConnectionResult> {
    const startTime = performance.now();
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      const latencyMs = Math.round(performance.now() - startTime);

      if (!res.ok) {
        const errorBody = await res.text();
        const normalized = this.normalizeHttpError(res.status, errorBody, 'models');
        return {
          connected: false,
          provider: 'XKIRO',
          keyLast4: this.keyLast4,
          error: normalized.message,
          latencyMs
        };
      }

      const json = await res.json();
      const rawList: any[] = json.data || [];
      const models = rawList.slice(0, 20).map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        description: m.description,
        contextLength: m.context_length || 64000,
        isFree: false,
        provider: 'XKIRO' as SupportedAIProvider
      }));

      const selectedModel = models[0]?.id || 'qwen/qwen3.5-flash:free';

      return {
        connected: true,
        provider: 'XKIRO',
        keyLast4: this.keyLast4,
        selectedModel,
        models,
        latencyMs
      };
    } catch (err: any) {
      return {
        connected: false,
        provider: 'XKIRO',
        keyLast4: this.keyLast4,
        error: err?.message || 'Failed to connect to xKiro',
        latencyMs: Math.round(performance.now() - startTime)
      };
    }
  }

  private getDefaultModels(): AIModel[] {
    return [
      {
        id: 'qwen/qwen3.5-flash:free',
        name: 'Qwen 3.5 Flash (Free) [Curated Fallback]',
        description: 'Verified high-speed balanced model for structured outreach (curated fallback catalog)',
        contextLength: 1000000,
        isFree: true,
        provider: 'XKIRO',
        source: 'CURATED_FALLBACK',
        isFallback: true
      },
      {
        id: 'qwen/qwen3.6-27b:free',
        name: 'Qwen 3.6 27B (Free) [Curated Fallback]',
        description: 'Verified extended context reasoning model (curated fallback catalog)',
        contextLength: 262144,
        isFree: true,
        provider: 'XKIRO',
        source: 'CURATED_FALLBACK',
        isFallback: true
      },
      {
        id: 'deepseek/deepseek-chat-v3.1',
        name: 'DeepSeek Chat v3.1 [Curated Fallback]',
        description: 'Verified advanced reasoning and outreach synthesis (curated fallback catalog)',
        contextLength: 163840,
        isFree: false,
        provider: 'XKIRO',
        source: 'CURATED_FALLBACK',
        isFallback: true
      }
    ];
  }

  private normalizeHttpError(status: number, body: string, modelName?: string, retryAfterSeconds?: number | undefined): AIProviderError {
    let message = body;
    try {
      const parsed = JSON.parse(body);
      message = parsed.error?.message || parsed.message || body;
    } catch (_) {}

    if (status === 401 || status === 403) {
      return new AIProviderError(
        'AI_INVALID_API_KEY',
        'xKiro API key is invalid or unauthorized. Please verify your key with xKiro.',
        401,
        'XKIRO'
      );
    }

    if (status === 402) {
      return new AIProviderError(
        'AI_QUOTA_EXCEEDED',
        'Insufficient xKiro credits. Please check your account quota.',
        402,
        'XKIRO'
      );
    }

    if (status === 429) {
      return new AIProviderError(
        'AI_RATE_LIMITED',
        'xKiro rate limit reached. Please wait a moment before trying again.',
        429,
        'XKIRO',
        retryAfterSeconds
      );
    }

    if (status === 404) {
      return new AIProviderError(
        'AI_MODEL_NOT_FOUND',
        `xKiro model "${modelName}" was not found.`,
        404,
        'XKIRO'
      );
    }

    if (status === 504) {
      return new AIProviderError(
        'AI_REQUEST_TIMEOUT',
        'xKiro request timed out.',
        504,
        'XKIRO'
      );
    }

    return new AIProviderError(
      'AI_PROVIDER_UNAVAILABLE',
      `xKiro request failed (${status}): ${message.slice(0, 150)}`,
      status >= 500 ? 502 : 400,
      'XKIRO'
    );
  }

  private normalizeNetworkError(err: any): AIProviderError {
    const msg = err?.message || String(err);
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      return new AIProviderError('AI_REQUEST_TIMEOUT', 'xKiro request timed out.', 504, 'XKIRO');
    }
    return new AIProviderError('AI_PROVIDER_UNAVAILABLE', `xKiro connection error: ${msg.slice(0, 150)}`, 502, 'XKIRO');
  }
}
