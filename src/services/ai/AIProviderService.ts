import { PrismaClient } from '@prisma/client';
import { AIProviderResolver } from './AIProviderResolver';
import { AIUsageLimitService } from './AIUsageLimitService';
import { AIModelService } from './AIModelService';
import {
  SupportedAIProvider,
  AITextResponse,
  AIConnectionResult,
  AIModel,
  UserAIProviderStatus
} from './types/ai';
import { AIProviderError } from './errors/aiErrors';
import { encrypt, decrypt } from '../../utils/crypto';
import { GeminiProvider } from './providers/GeminiProvider';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { XKiroProvider } from './providers/XKiroProvider';

const prisma = new PrismaClient();

export interface GenerateTextParams {
  userId: string;
  feature: 'PERSONALIZATION' | 'EMAIL_GENERATION' | 'OTHER_AI_FEATURE';
  systemPrompt: string;
  userPrompt: string;
  provider?: SupportedAIProvider | undefined;
  model?: string | undefined;
  models?: string[] | undefined;
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
}

export class AIProviderService {
  /**
   * Main text generation entrypoint for features.
   */
  static async generateText(params: GenerateTextParams): Promise<{
    text: string;
    provider: SupportedAIProvider | 'GEMINI_USER' | 'GEMINI_PLATFORM';
    model: string;
    keyLast4: string;
    latencyMs: number;
  }> {
    const requestedAt = new Date();

    // 1. Resolve target provider and credentials for this user
    const context = await AIProviderResolver.resolve(params.userId, params.provider);

    // 2. Enforce per-user quota before executing
    await AIUsageLimitService.checkQuota(params.userId, context.providerType, context.isPlatformFallback);

    // 3. Execute generation
    const selectedModel = params.model || context.model;
    let response: AITextResponse;

    try {
      response = await context.provider.generateText({
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
        model: selectedModel,
        temperature: params.temperature,
        maxOutputTokens: params.maxOutputTokens
      });
    } catch (err: any) {
      // Record failure telemetry
      await AIUsageLimitService.recordUsage({
        userId: params.userId,
        provider: context.isPlatformFallback ? `${context.providerType}_PLATFORM` : `${context.providerType}_USER`,
        feature: params.feature,
        status: 'FAILED',
        requestedAt,
        completedAt: new Date(),
        errorCode: err?.code || 'AI_UNKNOWN_ERROR'
      });

      throw err;
    }

    // 4. Record success telemetry
    await AIUsageLimitService.recordUsage({
      userId: params.userId,
      provider: context.isPlatformFallback ? `${context.providerType}_PLATFORM` : `${context.providerType}_USER`,
      feature: params.feature,
      status: 'SUCCESS',
      requestedAt,
      completedAt: new Date(),
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      totalTokens: response.totalTokens
    });

    // 5. Update lastUsedAt if a user key was used
    if (context.userKeyId) {
      prisma.userAIKey.update({
        where: { id: context.userKeyId },
        data: { lastUsedAt: new Date() }
      }).catch(() => {});
    }

    // Return legacy-compatible provider string if requested by older callers
    const legacyProvider = context.isPlatformFallback ? 'GEMINI_PLATFORM' : 'GEMINI_USER';
    const providerOutput = context.providerType === 'GEMINI' ? legacyProvider : context.providerType;

    return {
      text: response.text,
      provider: providerOutput,
      model: response.model,
      keyLast4: context.keyLast4,
      latencyMs: response.latencyMs
    };
  }

  /**
   * Tests connection for an explicit provider using the user's stored encrypted key.
   */
  static async testConnection(userId: string, provider: SupportedAIProvider): Promise<AIConnectionResult> {
    const userKey = await prisma.userAIKey.findUnique({
      where: {
        userId_provider: { userId, provider }
      }
    });

    if (!userKey || !userKey.isActive || !userKey.encryptedApiKey) {
      throw new AIProviderError(
        'AI_PROVIDER_NOT_CONFIGURED',
        `No API key configured for ${provider}.`,
        400,
        provider
      );
    }

    const decrypted = decrypt(userKey.encryptedApiKey);
    if (!decrypted) {
      throw new AIProviderError('AI_INVALID_API_KEY', 'Stored API key could not be decrypted.', 500, provider);
    }

    let p;
    switch (provider) {
      case 'GEMINI':
        p = new GeminiProvider(decrypted);
        break;
      case 'OPENROUTER':
        p = new OpenRouterProvider(decrypted);
        break;
      case 'XKIRO':
        p = new XKiroProvider(decrypted);
        break;
      default:
        throw new AIProviderError('AI_PROVIDER_NOT_CONFIGURED', `Unsupported provider: ${provider}`, 400);
    }

    return p.testConnection();
  }

  /**
   * Saves or updates a user's encrypted key for a specific provider.
   */
  static async saveKey(params: {
    userId: string;
    provider: SupportedAIProvider;
    apiKey: string;
    selectedModel?: string;
    skipValidation?: boolean;
  }): Promise<{ success: boolean; provider: SupportedAIProvider; keyLast4: string }> {
    const cleanKey = params.apiKey.trim();
    if (!cleanKey || cleanKey.length < 8) {
      throw new AIProviderError('AI_INVALID_API_KEY', `Invalid ${params.provider} API key format.`, 400, params.provider);
    }

    // Validate key with probe unless skipped
    if (!params.skipValidation) {
      let testResult: AIConnectionResult;
      switch (params.provider) {
        case 'GEMINI': {
          const isValid = await AIProviderService.validateGeminiKey(cleanKey);
          testResult = {
            connected: isValid,
            provider: 'GEMINI',
            keyLast4: cleanKey.slice(-4),
            error: isValid ? undefined : 'Failed to validate GEMINI API key.'
          };
          break;
        }
        case 'OPENROUTER': {
          const p = new OpenRouterProvider(cleanKey);
          testResult = await p.testConnection();
          break;
        }
        case 'XKIRO': {
          const p = new XKiroProvider(cleanKey);
          testResult = await p.testConnection();
          break;
        }
        default:
          throw new AIProviderError('AI_PROVIDER_NOT_CONFIGURED', `Unsupported provider: ${params.provider}`, 400);
      }

      if (!testResult.connected) {
        throw new AIProviderError(
          'AI_PROVIDER_AUTH_FAILED',
          testResult.error || `Failed to validate ${params.provider} API key.`,
          400,
          params.provider
        );
      }
    }

    const encryptedApiKey = encrypt(cleanKey);
    const keyLast4 = cleanKey.slice(-4);

    // Upsert UserAIKey for this user and provider
    await prisma.userAIKey.upsert({
      where: {
        userId_provider: {
          userId: params.userId,
          provider: params.provider
        }
      },
      create: {
        userId: params.userId,
        provider: params.provider,
        encryptedApiKey,
        keyLast4,
        isActive: true
      },
      update: {
        encryptedApiKey,
        keyLast4,
        isActive: true,
        updatedAt: new Date()
      }
    });

    // Save model preference if provided
    if (params.selectedModel) {
      await this.savePreference({
        userId: params.userId,
        provider: params.provider,
        selectedModel: params.selectedModel
      });
    }

    // Invalidate model cache
    AIModelService.clearCache(params.provider);

    return {
      success: true,
      provider: params.provider,
      keyLast4
    };
  }

  /**
   * Deletes a user's key for a specific provider.
   */
  static async removeKey(userId: string, provider: SupportedAIProvider): Promise<void> {
    await prisma.userAIKey.deleteMany({
      where: {
        userId,
        provider
      }
    });

    // Invalidate model cache
    AIModelService.clearCache(provider);
  }

  /**
   * Saves model and default provider preferences.
   */
  static async savePreference(params: {
    userId: string;
    provider: SupportedAIProvider;
    selectedModel?: string | undefined;
    isDefault?: boolean | undefined;
  }): Promise<void> {
    if (params.isDefault) {
      // Clear other defaults
      await prisma.aIModelPreference.updateMany({
        where: { userId: params.userId },
        data: { isDefault: false }
      });
    }

    const defaultModel = AIModelService.getDefaultModel(params.provider);
    const modelToSave = params.selectedModel || defaultModel;

    await prisma.aIModelPreference.upsert({
      where: {
        userId_provider: {
          userId: params.userId,
          provider: params.provider
        }
      },
      create: {
        userId: params.userId,
        provider: params.provider,
        selectedModel: modelToSave,
        isDefault: params.isDefault ?? false
      },
      update: {
        ...(params.selectedModel ? { selectedModel: params.selectedModel } : {}),
        ...(params.isDefault !== undefined ? { isDefault: params.isDefault } : {}),
        updatedAt: new Date()
      }
    });
  }

  /**
   * Returns complete AI status across all 3 providers for settings UI.
   */
  static async getAllProvidersStatus(userId: string): Promise<{
    providers: Record<SupportedAIProvider, UserAIProviderStatus>;
    defaultProvider: SupportedAIProvider;
    usageToday: number;
    analytics?: any;
    // Legacy top-level fields for backwards compatibility
    configured: boolean;
    keyLast4: string | null;
    provider: string;
    lastUsedAt: string | null;
    fallbackAvailable: boolean;
    fallbackDailyLimit: number;
    fallbackUsedToday: number;
  }> {
    const keys = await prisma.userAIKey.findMany({
      where: { userId }
    });

    const preferences = await prisma.aIModelPreference.findMany({
      where: { userId }
    });

    const usageToday = await AIUsageLimitService.getUserUsageToday(userId);

    const defaultPref = preferences.find(p => p.isDefault);
    const defaultProvider: SupportedAIProvider =
      (defaultPref?.provider as SupportedAIProvider) ||
      (keys.find(k => k.isActive)?.provider as SupportedAIProvider) ||
      'GEMINI';

    const providersMap: Record<SupportedAIProvider, UserAIProviderStatus> = {
      GEMINI: {
        configured: false,
        keyLast4: null,
        provider: 'GEMINI',
        selectedModel: 'gemini-3.6-flash',
        isActive: false,
        lastUsedAt: null,
        usageToday
      },
      OPENROUTER: {
        configured: false,
        keyLast4: null,
        provider: 'OPENROUTER',
        selectedModel: 'openrouter/free',
        isActive: false,
        lastUsedAt: null,
        usageToday
      },
      XKIRO: {
        configured: false,
        keyLast4: null,
        provider: 'XKIRO',
        selectedModel: 'qwen/qwen3.5-flash:free',
        isActive: false,
        lastUsedAt: null,
        usageToday
      }
    };

    for (const key of keys) {
      const p = key.provider as SupportedAIProvider;
      if (providersMap[p]) {
        const pref = preferences.find(pref => pref.provider === p);
        providersMap[p].configured = key.isActive;
        providersMap[p].keyLast4 = key.keyLast4;
        providersMap[p].isActive = key.isActive;
        providersMap[p].lastUsedAt = key.lastUsedAt?.toISOString() || null;
        if (pref?.selectedModel) {
          providersMap[p].selectedModel = pref.selectedModel;
        }
      }
    }

    const geminiStatus = providersMap.GEMINI;

    // Fetch real-time usage analytics from AIUsage
    const [usageGroups, tokenAgg, recentLogs] = await Promise.all([
      prisma.aIUsage.groupBy({
        by: ['provider', 'status'],
        where: { userId },
        _count: { id: true }
      }),
      prisma.aIUsage.aggregate({
        where: { userId },
        _sum: {
          inputTokens: true,
          outputTokens: true,
          totalTokens: true
        }
      }),
      prisma.aIUsage.findMany({
        where: { userId },
        orderBy: { requestedAt: 'desc' },
        take: 10,
        select: {
          id: true,
          provider: true,
          feature: true,
          status: true,
          errorCode: true,
          totalTokens: true,
          requestedAt: true,
          completedAt: true
        }
      })
    ]);

    const analyticsByProvider: Record<SupportedAIProvider, { total: number; success: number; failed: number }> = {
      GEMINI: { total: 0, success: 0, failed: 0 },
      OPENROUTER: { total: 0, success: 0, failed: 0 },
      XKIRO: { total: 0, success: 0, failed: 0 }
    };

    let totalRequests = 0;
    let successfulRequests = 0;
    let failedRequests = 0;

    for (const group of usageGroups) {
      const p = group.provider.replace(/_USER|_PLATFORM/g, '') as SupportedAIProvider;
      if (analyticsByProvider[p]) {
        analyticsByProvider[p].total += group._count.id;
        if (group.status === 'SUCCESS') {
          analyticsByProvider[p].success += group._count.id;
          successfulRequests += group._count.id;
        } else {
          analyticsByProvider[p].failed += group._count.id;
          failedRequests += group._count.id;
        }
        totalRequests += group._count.id;
      }
    }

    const analytics = {
      totalRequests,
      successfulRequests,
      failedRequests,
      tokens: {
        inputTokens: tokenAgg._sum.inputTokens || 0,
        outputTokens: tokenAgg._sum.outputTokens || 0,
        totalTokens: tokenAgg._sum.totalTokens || 0
      },
      byProvider: analyticsByProvider,
      recentLogs: recentLogs.map(l => ({
        id: l.id,
        provider: l.provider.replace(/_USER|_PLATFORM/g, ''),
        feature: l.feature,
        status: l.status,
        errorCode: l.errorCode,
        totalTokens: l.totalTokens || 0,
        latencyMs: l.completedAt && l.requestedAt ? l.completedAt.getTime() - l.requestedAt.getTime() : null,
        requestedAt: l.requestedAt.toISOString()
      }))
    };

    // Check admin fallback status for legacy fields
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true }
    });
    const fallbackAvailable =
      (process.env.PLATFORM_AI_FALLBACK_ENABLED === 'true' || user?.role === 'ADMIN') &&
      Boolean(process.env.GEMINI_API_KEY);

    return {
      providers: providersMap,
      defaultProvider,
      usageToday,
      analytics,
      // Legacy backwards-compatible fields
      configured: geminiStatus.configured || fallbackAvailable,
      keyLast4: geminiStatus.keyLast4,
      provider: geminiStatus.configured ? 'GEMINI' : fallbackAvailable ? 'GEMINI_PLATFORM' : 'NONE',
      lastUsedAt: geminiStatus.lastUsedAt,
      fallbackAvailable,
      fallbackDailyLimit: parseInt(process.env.PLATFORM_AI_DAILY_LIMIT || '10', 10),
      fallbackUsedToday: 0
    };
  }

  // =========================================================================
  // BACKWARDS-COMPATIBILITY METHODS FOR LEGACY CALLERS & TESTS
  // =========================================================================
  static async getUserAIStatus(userId: string) {
    return this.getAllProvidersStatus(userId);
  }

  static async validateGeminiKey(rawKey: string): Promise<boolean> {
    const p = new GeminiProvider(rawKey);
    const res = await p.testConnection();
    if (!res.connected) {
      throw new AIProviderError('AI_PROVIDER_AUTH_FAILED', res.error || 'Invalid Gemini key', 400, 'GEMINI');
    }
    return true;
  }

  static async resolveCredentials(userId: string) {
    const ctx = await AIProviderResolver.resolve(userId, 'GEMINI');
    await AIUsageLimitService.checkQuota(userId, 'GEMINI', ctx.isPlatformFallback);
    const userKey = await prisma.userAIKey.findUnique({
      where: { userId_provider: { userId, provider: 'GEMINI' } }
    });
    const decrypted = userKey?.encryptedApiKey ? decrypt(userKey.encryptedApiKey) : '';
    return {
      type: ctx.isPlatformFallback ? 'GEMINI_PLATFORM' : 'GEMINI_USER',
      apiKey: decrypted || process.env.GEMINI_API_KEY || '',
      keyLast4: ctx.keyLast4,
      userKeyId: ctx.userKeyId
    };
  }
}
