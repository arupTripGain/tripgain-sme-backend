import { GoogleGenAI } from '@google/genai';
import {
  AIProvider,
  AITextRequest,
  AITextResponse,
  AIModel,
  AIConnectionResult,
  SupportedAIProvider
} from '../types/ai';
import { AIProviderError } from '../errors/aiErrors';

export class GeminiProvider implements AIProvider {
  readonly providerName: SupportedAIProvider = 'GEMINI';
  private apiKey: string;
  private keyLast4: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.keyLast4 = apiKey.length >= 4 ? apiKey.slice(-4) : '****';
  }

  async generateText(request: AITextRequest): Promise<AITextResponse> {
    const startTime = performance.now();
    const ai = new GoogleGenAI({ apiKey: this.apiKey });

    const model = request.model || 'gemini-3.6-flash';

    try {
      const response = await ai.models.generateContent({
        model,
        contents: request.userPrompt,
        config: {
          ...(request.systemPrompt ? { systemInstruction: request.systemPrompt } : {}),
          temperature: request.temperature ?? 0.7,
          maxOutputTokens: request.maxOutputTokens ?? 2048
        }
      });

      const text = response?.text || '';
      const latencyMs = Math.round(performance.now() - startTime);

      const usage = (response as any)?.usageMetadata;
      const inputTokens = usage?.promptTokenCount;
      const outputTokens = usage?.candidatesTokenCount;
      const totalTokens = usage?.totalTokenCount;

      return {
        provider: 'GEMINI',
        model,
        text,
        inputTokens,
        outputTokens,
        totalTokens,
        latencyMs,
        finishReason: (response as any)?.candidates?.[0]?.finishReason || 'STOP'
      };
    } catch (err: any) {
      throw this.normalizeError(err, model);
    }
  }

  async listModels(): Promise<AIModel[]> {
    if (this.apiKey && this.apiKey.trim().length > 0) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`);
        if (res.ok) {
          const json = await res.json();
          const rawModels: any[] = json.models || [];
          const textModels = rawModels.filter((m: any) =>
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes('generateContent')
          );

          if (textModels.length > 0) {
            return textModels.map((m: any) => {
              const cleanId = (m.name || '').replace(/^models\//, '');
              const isFree = cleanId.includes('flash');
              return {
                id: cleanId,
                name: m.displayName || cleanId,
                description: m.description || `Google Gemini ${cleanId} model`,
                contextLength: m.inputTokenLimit || 1000000,
                isFree,
                provider: 'GEMINI' as SupportedAIProvider,
                source: 'DYNAMIC',
                isFallback: false
              };
            });
          }
        }
      } catch (_) {
        // Fall through to clearly labeled curated fallback
      }
    }

    return this.getDefaultModels();
  }

  private getDefaultModels(): AIModel[] {
    return [
      {
        id: 'gemini-3.6-flash',
        name: 'Gemini 3.6 Flash [Curated Fallback]',
        description: 'Google current recommended high-speed multimodal model (curated fallback catalog)',
        contextLength: 1000000,
        isFree: true,
        provider: 'GEMINI',
        source: 'CURATED_FALLBACK',
        isFallback: true
      },
      {
        id: 'gemini-flash-lite-latest',
        name: 'Gemini Flash Lite [Curated Fallback]',
        description: 'Ultra-fast lightweight generation for high-throughput tasks (curated fallback catalog)',
        contextLength: 1000000,
        isFree: true,
        provider: 'GEMINI',
        source: 'CURATED_FALLBACK',
        isFallback: true
      },
      {
        id: 'gemini-pro-latest',
        name: 'Gemini Pro Latest [Curated Fallback]',
        description: 'Complex reasoning and deep synthesis (curated fallback catalog)',
        contextLength: 2000000,
        isFree: false,
        provider: 'GEMINI',
        source: 'CURATED_FALLBACK',
        isFallback: true
      }
    ];
  }

  async testConnection(): Promise<AIConnectionResult> {
    const startTime = performance.now();
    try {
      const ai = new GoogleGenAI({ apiKey: this.apiKey });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Validation request timed out')), 6000)
      );

      const probePromise = ai.models.generateContent({
        model: 'gemini-flash-lite-latest',
        contents: 'test',
        config: { maxOutputTokens: 2 }
      });

      await Promise.race([probePromise, timeoutPromise]);
      const latencyMs = Math.round(performance.now() - startTime);

      const models = await this.listModels();
      return {
        connected: true,
        provider: 'GEMINI',
        keyLast4: this.keyLast4,
        selectedModel: 'gemini-3.6-flash',
        models,
        latencyMs
      };
    } catch (err: any) {
      const normalized = this.normalizeError(err, 'gemini-flash-lite-latest');
      return {
        connected: false,
        provider: 'GEMINI',
        keyLast4: this.keyLast4,
        error: normalized.message,
        latencyMs: Math.round(performance.now() - startTime)
      };
    }
  }

  private normalizeError(err: any, modelName?: string): AIProviderError {
    const msg = err?.message || String(err);
    const lower = msg.toLowerCase();

    if (
      lower.includes('api_key_invalid') ||
      lower.includes('401') ||
      lower.includes('403') ||
      lower.includes('unauthorized') ||
      lower.includes('forbidden')
    ) {
      return new AIProviderError(
        'AI_INVALID_API_KEY',
        'Gemini API key is invalid or unauthorized. Please verify your key in Google AI Studio.',
        401,
        'GEMINI'
      );
    }

    if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
      return new AIProviderError(
        'AI_RATE_LIMITED',
        'Gemini rate limit exceeded. Please wait a moment before trying again.',
        429,
        'GEMINI'
      );
    }

    if (lower.includes('not found') || lower.includes('model not found')) {
      return new AIProviderError(
        'AI_MODEL_NOT_FOUND',
        `Gemini model "${modelName}" not found or deprecated.`,
        404,
        'GEMINI'
      );
    }

    if (lower.includes('timed out') || lower.includes('timeout')) {
      return new AIProviderError(
        'AI_REQUEST_TIMEOUT',
        'Gemini API request timed out.',
        504,
        'GEMINI'
      );
    }

    if (lower.includes('safety') || lower.includes('blocked') || lower.includes('filter')) {
      return new AIProviderError(
        'AI_CONTENT_FILTERED',
        'Response content was filtered by Gemini safety guidelines.',
        400,
        'GEMINI'
      );
    }

    return new AIProviderError(
      'AI_PROVIDER_UNAVAILABLE',
      `Gemini request failed: ${msg.slice(0, 150)}`,
      502,
      'GEMINI'
    );
  }
}
