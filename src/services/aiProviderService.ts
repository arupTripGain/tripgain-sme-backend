import { PrismaClient } from '@prisma/client';
import { GoogleGenAI } from '@google/genai';
import { decrypt } from '../utils/crypto';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

export interface AIProviderCredentials {
  type: 'GEMINI_USER' | 'GEMINI_PLATFORM';
  apiKey: string;
  keyLast4: string;
  userKeyId?: string;
}

export class AIProviderError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number = 400) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.status = status;
  }
}

function getPlatformGeminiKey(): string {
  let key = (process.env.GEMINI_API_KEY || '').replace(/^\"|\"$/g, '').trim();
  if (!key) {
    try {
      const envPath = path.resolve(__dirname, '../../.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/^GEMINI_API_KEY=["']?([^"'\r\n]+)["']?/m);
        if (match && match[1]) key = match[1].trim();
      }
    } catch (_) {}
  }
  return key;
}

export class AIProviderService {
  /**
   * Resolves the AI credential for a user following the BYOK security hierarchy:
   * 1. User's own encrypted Gemini key if active
   * 2. Platform Gemini key fallback if explicitly permitted for that user
   * 3. Rejects with AI_PROVIDER_NOT_CONFIGURED
   */
  static async resolveCredentials(userId: string): Promise<AIProviderCredentials> {
    if (!userId) {
      throw new AIProviderError(
        'AI_PROVIDER_NOT_CONFIGURED',
        'Authentication required to resolve AI provider credentials.',
        401
      );
    }

    // 1. Check user-configured BYOK key
    const userKey = await prisma.userAIKey.findUnique({
      where: { userId }
    });

    if (userKey && userKey.isActive && userKey.encryptedApiKey) {
      const decrypted = decrypt(userKey.encryptedApiKey);
      if (decrypted && decrypted.trim().length > 0) {
        return {
          type: 'GEMINI_USER',
          apiKey: decrypted.trim(),
          keyLast4: userKey.keyLast4,
          userKeyId: userKey.id
        };
      }
    }

    // 2. Check platform key fallback permissions
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, email: true }
    });

    const isPlatformFallbackEnabled =
      process.env.PLATFORM_AI_FALLBACK_ENABLED === 'true' ||
      user?.role === 'ADMIN';

    if (isPlatformFallbackEnabled) {
      const platformKey = getPlatformGeminiKey();
      if (!platformKey) {
        throw new AIProviderError(
          'AI_PROVIDER_NOT_CONFIGURED',
          'A Gemini API key is required. Please connect your Gemini API key in Settings.',
          400
        );
      }

      // Check per-user daily platform limit (default 10)
      const userDailyLimit = parseInt(process.env.PLATFORM_AI_DAILY_LIMIT || '10', 10);
      const globalDailyLimit = parseInt(process.env.PLATFORM_AI_GLOBAL_DAILY_LIMIT || '100', 10);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const userUsageToday = await prisma.aIUsage.count({
        where: {
          userId,
          provider: 'GEMINI_PLATFORM',
          requestedAt: { gte: today }
        }
      });

      if (userUsageToday >= userDailyLimit) {
        throw new AIProviderError(
          'AI_USAGE_LIMIT_REACHED',
          `Platform AI daily limit of ${userDailyLimit} requests has been reached. Please connect your own Gemini API key in Settings for unlimited usage.`,
          429
        );
      }

      const globalUsageToday = await prisma.aIUsage.count({
        where: {
          provider: 'GEMINI_PLATFORM',
          requestedAt: { gte: today }
        }
      });

      if (globalUsageToday >= globalDailyLimit) {
        throw new AIProviderError(
          'AI_USAGE_LIMIT_REACHED',
          'Global platform AI daily capacity has been reached. Please connect your own Gemini API key in Settings.',
          429
        );
      }

      const keyLast4 = platformKey.length >= 4 ? platformKey.slice(-4) : '****';
      return {
        type: 'GEMINI_PLATFORM',
        apiKey: platformKey,
        keyLast4
      };
    }

    // 3. Neither user key nor platform fallback is available
    throw new AIProviderError(
      'AI_PROVIDER_NOT_CONFIGURED',
      'A Gemini API key is required for AI features. Please connect your Gemini API key in Settings.',
      400
    );
  }

  /**
   * Minimal server-side validation probe for a Gemini API key before saving.
   * Uses minimal token generation to keep latency and cost minimal.
   */
  static async validateGeminiKey(rawKey: string): Promise<boolean> {
    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim().length < 15) {
      throw new AIProviderError(
        'AI_PROVIDER_AUTH_FAILED',
        'Invalid Gemini API key format.',
        400
      );
    }

    const key = rawKey.trim();
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Validation request timed out')), 6000)
      );

      const probePromise = ai.models.generateContent({
        model: 'gemini-flash-lite-latest',
        contents: 'test',
        config: { maxOutputTokens: 2 }
      });

      await Promise.race([probePromise, timeoutPromise]);
      return true;
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (
        msg.includes('API_KEY_INVALID') ||
        msg.includes('403') ||
        msg.includes('401') ||
        msg.includes('unauthorized') ||
        msg.includes('Forbidden')
      ) {
        throw new AIProviderError(
          'AI_PROVIDER_AUTH_FAILED',
          'Gemini API key is invalid or unauthorized. Please verify your key in Google AI Studio.',
          400
        );
      }
      if (msg.includes('timed out')) {
        throw new AIProviderError(
          'AI_PROVIDER_UNAVAILABLE',
          'Validation timed out. Please check your network connection or try again.',
          504
        );
      }
      throw new AIProviderError(
        'AI_PROVIDER_AUTH_FAILED',
        `Unable to validate Gemini API key: ${msg.slice(0, 100)}`,
        400
      );
    }
  }

  /**
   * Executes an AI text generation request using the resolved credentials,
   * handles model fallbacks, logs AIUsage, and updates lastUsedAt.
   */
  static async generateText(params: {
    userId: string;
    feature: 'PERSONALIZATION' | 'EMAIL_GENERATION' | 'OTHER_AI_FEATURE';
    systemPrompt: string;
    userPrompt: string;
    models?: string[];
    temperature?: number;
    maxOutputTokens?: number;
  }): Promise<{ text: string; provider: 'GEMINI_USER' | 'GEMINI_PLATFORM'; keyLast4: string }> {
    const creds = await this.resolveCredentials(params.userId);

    const requestedAt = new Date();
    const ai = new GoogleGenAI({ apiKey: creds.apiKey });

    const candidateModels = params.models || [
      'gemini-flash-lite-latest',
      'gemini-flash-latest',
      'gemini-3.5-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.5-flash'
    ];

    let response: any;
    let lastError: any;

    for (const model of candidateModels) {
      try {
        response = await ai.models.generateContent({
          model,
          contents: params.userPrompt,
          config: {
            systemInstruction: params.systemPrompt,
            temperature: params.temperature ?? 0.7,
            maxOutputTokens: params.maxOutputTokens ?? 2048
          }
        });
        if (response?.text) {
          break;
        }
      } catch (err: any) {
        lastError = err;
        const msg = err?.message || '';
        // If auth failure on user key, stop trying other models and fail immediately
        if (msg.includes('API_KEY_INVALID') || msg.includes('403') || msg.includes('401')) {
          break;
        }
      }
    }

    const completedAt = new Date();

    if (!response || !response.text) {
      const errMessage = lastError?.message || 'All AI models unavailable';
      let errorCode = 'AI_GENERATION_FAILED';
      if (errMessage.includes('API_KEY_INVALID') || errMessage.includes('403') || errMessage.includes('401')) {
        errorCode = 'AI_PROVIDER_AUTH_FAILED';
      } else if (errMessage.includes('429') || errMessage.includes('RESOURCE_EXHAUSTED')) {
        errorCode = 'AI_PROVIDER_RATE_LIMITED';
      }

      // Record failed usage
      await prisma.aIUsage.create({
        data: {
          userId: params.userId,
          provider: creds.type,
          feature: params.feature,
          status: 'FAILED',
          requestedAt,
          completedAt,
          errorCode
        }
      }).catch(() => {});

      throw new AIProviderError(errorCode, errMessage, 500);
    }

    const text = response.text || '';

    // Record successful usage
    const totalTokens = Math.ceil((params.systemPrompt.length + params.userPrompt.length + text.length) / 4);
    await prisma.aIUsage.create({
      data: {
        userId: params.userId,
        provider: creds.type,
        feature: params.feature,
        status: 'SUCCESS',
        requestedAt,
        completedAt,
        totalTokens
      }
    }).catch(() => {});

    // Update lastUsedAt on UserAIKey if user key was used
    if (creds.type === 'GEMINI_USER' && creds.userKeyId) {
      await prisma.userAIKey.update({
        where: { id: creds.userKeyId },
        data: { lastUsedAt: new Date() }
      }).catch(() => {});
    }

    return {
      text,
      provider: creds.type,
      keyLast4: creds.keyLast4
    };
  }

  /**
   * Retrieves summary status of the user's AI configuration and usage.
   */
  static async getUserAIStatus(userId: string): Promise<{
    configured: boolean;
    provider: string;
    keyLast4?: string | null;
    lastUsedAt?: Date | null;
    todayRequests: number;
    usageToday: number;
    platformFallbackAllowed: boolean;
    fallbackAvailable: boolean;
    platformUsageToday: number;
    fallbackUsedToday: number;
    platformDailyLimit: number;
    fallbackDailyLimit: number;
  }> {
    const userKey = await prisma.userAIKey.findUnique({
      where: { userId }
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayRequests = await prisma.aIUsage.count({
      where: {
        userId,
        requestedAt: { gte: today }
      }
    });

    const platformUsageToday = await prisma.aIUsage.count({
      where: {
        userId,
        provider: 'GEMINI_PLATFORM',
        requestedAt: { gte: today }
      }
    });

    const platformFallbackAllowed =
      process.env.PLATFORM_AI_FALLBACK_ENABLED === 'true' ||
      user?.role === 'ADMIN';

    const platformDailyLimit = parseInt(process.env.PLATFORM_AI_DAILY_LIMIT || '10', 10);

    if (userKey && userKey.isActive) {
      return {
        configured: true,
        provider: userKey.provider,
        keyLast4: userKey.keyLast4,
        lastUsedAt: userKey.lastUsedAt,
        todayRequests,
        usageToday: todayRequests,
        platformFallbackAllowed,
        fallbackAvailable: platformFallbackAllowed,
        platformUsageToday,
        fallbackUsedToday: platformUsageToday,
        platformDailyLimit,
        fallbackDailyLimit: platformDailyLimit
      };
    }

    return {
      configured: false,
      provider: 'NONE',
      keyLast4: null,
      lastUsedAt: null,
      todayRequests,
      usageToday: todayRequests,
      platformFallbackAllowed,
      fallbackAvailable: platformFallbackAllowed,
      platformUsageToday,
      fallbackUsedToday: platformUsageToday,
      platformDailyLimit,
      fallbackDailyLimit: platformDailyLimit
    };
  }
}
