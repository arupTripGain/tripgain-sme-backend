import { PrismaClient } from '@prisma/client';
import { SupportedAIProvider } from './types/ai';
import { AIProviderError } from './errors/aiErrors';

const prisma = new PrismaClient();

export interface RecordUsageParams {
  userId: string;
  provider: string; // e.g. 'GEMINI_USER', 'OPENROUTER_USER', 'XKIRO_USER', 'GEMINI_PLATFORM'
  feature: 'PERSONALIZATION' | 'EMAIL_GENERATION' | 'OTHER_AI_FEATURE';
  status: 'SUCCESS' | 'FAILED';
  requestedAt: Date;
  completedAt?: Date | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  errorCode?: string | undefined;
}

export class AIUsageLimitService {
  // Default daily limit per user for their own BYOK keys (high ceiling for safety against runaway loops)
  private static DEFAULT_BYOK_DAILY_LIMIT = 2000;
  // Fallback platform key limit
  private static DEFAULT_PLATFORM_DAILY_LIMIT = 10;

  /**
   * Checks whether the user has exceeded their daily quota before dispatching an AI request.
   */
  static async checkQuota(userId: string, provider: SupportedAIProvider, isPlatformFallback: boolean = false): Promise<void> {
    if (!userId) {
      throw new AIProviderError('AI_PROVIDER_NOT_CONFIGURED', 'Authentication required for AI usage check.', 401);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const providerTag = isPlatformFallback ? `${provider}_PLATFORM` : `${provider}_USER`;

    const usageToday = await prisma.aIUsage.count({
      where: {
        userId,
        provider: providerTag,
        requestedAt: { gte: today },
        status: 'SUCCESS'
      }
    });

    const limit = isPlatformFallback
      ? parseInt(process.env.PLATFORM_AI_DAILY_LIMIT || String(this.DEFAULT_PLATFORM_DAILY_LIMIT), 10)
      : parseInt(process.env.BYOK_AI_DAILY_LIMIT || String(this.DEFAULT_BYOK_DAILY_LIMIT), 10);

    if (usageToday >= limit) {
      const msg = isPlatformFallback
        ? `Platform AI daily limit of ${limit} requests reached. Please connect your own API key in Settings for unlimited access.`
        : `Daily AI usage limit of ${limit} requests reached for your account.`;
      throw new AIProviderError('AI_USAGE_LIMIT_REACHED', msg, 429, provider);
    }
  }

  /**
   * Records completed or failed AI request telemetry in the database.
   */
  static async recordUsage(params: RecordUsageParams): Promise<void> {
    try {
      await prisma.aIUsage.create({
        data: {
          userId: params.userId,
          provider: params.provider,
          feature: params.feature,
          status: params.status,
          requestedAt: params.requestedAt,
          completedAt: params.completedAt || new Date(),
          inputTokens: params.inputTokens ?? null,
          outputTokens: params.outputTokens ?? null,
          totalTokens: params.totalTokens ?? null,
          errorCode: params.errorCode ?? null
        }
      });
    } catch (err: any) {
      console.error('[AIUsageLimitService] Failed to record AI usage telemetry:', err?.message);
    }
  }

  /**
   * Returns user usage count for today
   */
  static async getUserUsageToday(userId: string): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return prisma.aIUsage.count({
      where: {
        userId,
        requestedAt: { gte: today }
      }
    });
  }
}
