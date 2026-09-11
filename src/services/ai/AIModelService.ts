import { AIModel, SupportedAIProvider } from './types/ai';
import { GeminiProvider } from './providers/GeminiProvider';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { XKiroProvider } from './providers/XKiroProvider';

interface CachedCatalog {
  timestamp: number;
  models: AIModel[];
}

export class AIModelService {
  private static cache: Map<string, CachedCatalog> = new Map();
  private static CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  /**
   * Retrieves available models for a provider using the user's decrypted API key,
   * with TTL in-memory caching.
   */
  static async getModels(provider: SupportedAIProvider, apiKey: string): Promise<AIModel[]> {
    const cacheKey = `${provider}:${apiKey.slice(-6)}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.models;
    }

    let models: AIModel[] = [];
    switch (provider) {
      case 'GEMINI': {
        const p = new GeminiProvider(apiKey);
        models = await p.listModels();
        break;
      }
      case 'OPENROUTER': {
        const p = new OpenRouterProvider(apiKey);
        models = await p.listModels();
        break;
      }
      case 'XKIRO': {
        const p = new XKiroProvider(apiKey);
        models = await p.listModels();
        break;
      }
      default:
        models = [];
    }

    if (models.length > 0) {
      this.cache.set(cacheKey, { timestamp: Date.now(), models });
    }

    return models;
  }

  /**
   * Clear cache for a specific key (e.g. on key rotation/deletion)
   */
  static clearCache(provider?: SupportedAIProvider): void {
    if (provider) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${provider}:`)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  /**
   * Validates if a model is valid for the provider
   */
  static async isValidModel(provider: SupportedAIProvider, modelId: string, apiKey: string): Promise<boolean> {
    if (!modelId) return false;
    // Fast-path for standard free/default models
    if (provider === 'OPENROUTER' && (modelId === 'openrouter/free' || modelId.includes(':free'))) return true;
    if (provider === 'GEMINI' && modelId.startsWith('gemini-')) return true;
    if (provider === 'XKIRO' && (modelId.startsWith('qwen/') || modelId.startsWith('deepseek/') || modelId.startsWith('anthropic/'))) return true;

    try {
      const models = await this.getModels(provider, apiKey);
      return models.some(m => m.id === modelId);
    } catch (_) {
      // If listing fails, accept non-empty string to avoid blocking users
      return modelId.trim().length > 0;
    }
  }

  /**
   * Returns the recommended/default model ID for a provider
   */
  static getDefaultModel(provider: SupportedAIProvider): string {
    switch (provider) {
      case 'GEMINI':
        return 'gemini-3.6-flash';
      case 'OPENROUTER':
        return 'openrouter/free';
      case 'XKIRO':
        return 'qwen/qwen3.5-flash:free';
      default:
        return 'gemini-3.6-flash';
    }
  }
}
