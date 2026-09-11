import {
  AIProvider,
  AITextRequest,
  AITextResponse,
  AIModel,
  AIConnectionResult,
  SupportedAIProvider
} from '../types/ai';
import { AIProviderError } from '../errors/aiErrors';

export class OpenRouterProvider implements AIProvider {
  readonly providerName: SupportedAIProvider = 'OPENROUTER';
  private apiKey: string;
  private keyLast4: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey.trim();
    this.keyLast4 = this.apiKey.length >= 4 ? this.apiKey.slice(-4) : '****';
    const targetUrl = baseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    this.baseUrl = targetUrl.replace(/\/+$/, '');
  }

  async generateText(request: AITextRequest): Promise<AITextResponse> {
    const startTime = performance.now();
    const model = request.model || 'openrouter/free';

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
          'HTTP-Referer': 'https://tripgain.com',
          'X-Title': 'TripGain SME Outreach',
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
        provider: 'OPENROUTER',
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
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://tripgain.com',
          'X-Title': 'TripGain SME Outreach'
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

      const models: AIModel[] = rawList.map((m: any) => {
        const pricing = m.pricing || {};
        const isFree =
          m.id?.includes(':free') ||
          m.id === 'openrouter/free' ||
          (parseFloat(pricing.prompt || '0') === 0 && parseFloat(pricing.completion || '0') === 0);

        return {
          id: m.id,
          name: m.name || m.id,
          description: m.description,
          contextLength: m.context_length,
          isFree,
          provider: 'OPENROUTER' as SupportedAIProvider,
          source: 'DYNAMIC',
          isFallback: false
        };
      });

      // Ensure openrouter/free is at top if not present
      if (!models.some(m => m.id === 'openrouter/free')) {
        models.unshift({
          id: 'openrouter/free',
          name: 'OpenRouter Free Model Router',
          description: 'Automatically routes to available high-speed free models',
          contextLength: 128000,
          isFree: true,
          provider: 'OPENROUTER',
          source: 'DYNAMIC',
          isFallback: false
        });
      }

      return models;
    } catch (_) {
      return this.getDefaultModels();
    }
  }

  async testConnection(): Promise<AIConnectionResult> {
    const startTime = performance.now();
    try {
      // Lightweight probe: fetch models endpoint which validates the key with 0 token spend
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://tripgain.com',
          'X-Title': 'TripGain SME Outreach'
        }
      });

      const latencyMs = Math.round(performance.now() - startTime);

      if (!res.ok) {
        const errorBody = await res.text();
        const normalized = this.normalizeHttpError(res.status, errorBody, 'models');
        return {
          connected: false,
          provider: 'OPENROUTER',
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
        contextLength: m.context_length,
        isFree: m.id?.includes(':free') || m.id === 'openrouter/free',
        provider: 'OPENROUTER' as SupportedAIProvider
      }));

      return {
        connected: true,
        provider: 'OPENROUTER',
        keyLast4: this.keyLast4,
        selectedModel: 'openrouter/free',
        models,
        latencyMs
      };
    } catch (err: any) {
      return {
        connected: false,
        provider: 'OPENROUTER',
        keyLast4: this.keyLast4,
        error: err?.message || 'Failed to connect to OpenRouter',
        latencyMs: Math.round(performance.now() - startTime)
      };
    }
  }

  private getDefaultModels(): AIModel[] {
    return [
      {
        id: 'openrouter/free',
        name: 'OpenRouter Free Model Router [Curated Fallback]',
        description: 'Default free router selecting optimal available free models (curated fallback catalog)',
        contextLength: 128000,
        isFree: true,
        provider: 'OPENROUTER',
        source: 'CURATED_FALLBACK',
        isFallback: true
      },
      {
        id: 'meta-llama/llama-3.3-70b-instruct:free',
        name: 'Meta: Llama 3.3 70B Instruct (Free) [Curated Fallback]',
        description: 'State-of-the-art open weights 70B model free tier (curated fallback catalog)',
        contextLength: 128000,
        isFree: true,
        provider: 'OPENROUTER',
        source: 'CURATED_FALLBACK',
        isFallback: true
      },
      {
        id: 'google/gemini-2.5-flash',
        name: 'Google: Gemini 2.5 Flash [Curated Fallback]',
        description: 'Fast, capable multimodal model through OpenRouter (curated fallback catalog)',
        contextLength: 1000000,
        isFree: false,
        provider: 'OPENROUTER',
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
        'OpenRouter API key is invalid or unauthorized. Please verify your key on openrouter.ai.',
        401,
        'OPENROUTER'
      );
    }

    if (status === 402) {
      return new AIProviderError(
        'AI_QUOTA_EXCEEDED',
        'Insufficient OpenRouter credits for the selected model. Please recharge your account on openrouter.ai.',
        402,
        'OPENROUTER'
      );
    }

    if (status === 429) {
      return new AIProviderError(
        'AI_RATE_LIMITED',
        'OpenRouter rate limit reached. Please wait a moment before trying again.',
        429,
        'OPENROUTER',
        retryAfterSeconds
      );
    }

    if (status === 404) {
      return new AIProviderError(
        'AI_MODEL_NOT_FOUND',
        `OpenRouter model "${modelName}" was not found or is currently unavailable.`,
        404,
        'OPENROUTER'
      );
    }

    if (status === 504) {
      return new AIProviderError(
        'AI_REQUEST_TIMEOUT',
        'OpenRouter request timed out.',
        504,
        'OPENROUTER'
      );
    }

    return new AIProviderError(
      'AI_PROVIDER_UNAVAILABLE',
      `OpenRouter request failed (${status}): ${message.slice(0, 150)}`,
      status >= 500 ? 502 : 400,
      'OPENROUTER'
    );
  }

  private normalizeNetworkError(err: any): AIProviderError {
    const msg = err?.message || String(err);
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      return new AIProviderError('AI_REQUEST_TIMEOUT', 'OpenRouter request timed out.', 504, 'OPENROUTER');
    }
    return new AIProviderError('AI_PROVIDER_UNAVAILABLE', `OpenRouter connection error: ${msg.slice(0, 150)}`, 502, 'OPENROUTER');
  }
}
