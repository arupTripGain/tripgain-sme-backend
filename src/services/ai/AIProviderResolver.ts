import { PrismaClient } from '@prisma/client';
import { decrypt } from '../../utils/crypto';
import { AIProvider, SupportedAIProvider } from './types/ai';
import { AIProviderError } from './errors/aiErrors';
import { GeminiProvider } from './providers/GeminiProvider';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { XKiroProvider } from './providers/XKiroProvider';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

export interface ResolvedProviderContext {
  provider: AIProvider;
  providerType: SupportedAIProvider;
  model?: string | undefined;
  keyLast4: string;
  isPlatformFallback: boolean;
  userKeyId?: string | undefined;
}

function getPlatformGeminiKey(): string {
  let key = (process.env.GEMINI_API_KEY || '').replace(/^\"|\"$/g, '').trim();
  if (!key) {
    try {
      const envPath = path.resolve(__dirname, '../../../.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/^GEMINI_API_KEY=["']?([^"'\r\n]+)["']?/m);
        if (match && match[1]) key = match[1].trim();
      }
    } catch (_) {}
  }
  return key;
}

export class AIProviderResolver {
  /**
   * Resolves the appropriate AI provider instance and model for an authenticated user.
   * 
   * Strict Rules:
   * 1. If explicitProvider is passed, resolves that specific provider's key.
   * 2. Otherwise, resolves user's default provider from AIModelPreference or most recently used active key.
   * 3. Zero cross-user key access.
   * 4. Zero automatic fallback to another provider.
   * 5. Zero platform fallback for normal users (only ADMIN fallback if explicitly permitted).
   */
  static async resolve(userId: string, explicitProvider?: SupportedAIProvider): Promise<ResolvedProviderContext> {
    if (!userId) {
      throw new AIProviderError(
        'AI_PROVIDER_NOT_CONFIGURED',
        'Authentication required to resolve AI provider credentials.',
        401
      );
    }

    // 1. Determine target provider
    let targetProvider: SupportedAIProvider = explicitProvider || 'GEMINI';

    if (!explicitProvider) {
      // Check user model preference for default provider
      const defaultPref = await prisma.aIModelPreference.findFirst({
        where: { userId, isDefault: true }
      });

      if (defaultPref && ['GEMINI', 'OPENROUTER', 'XKIRO'].includes(defaultPref.provider)) {
        targetProvider = defaultPref.provider as SupportedAIProvider;
      } else {
        // Find any active key for user
        const anyActiveKey = await prisma.userAIKey.findFirst({
          where: { userId, isActive: true },
          orderBy: { lastUsedAt: 'desc' }
        });
        if (anyActiveKey && ['GEMINI', 'OPENROUTER', 'XKIRO'].includes(anyActiveKey.provider)) {
          targetProvider = anyActiveKey.provider as SupportedAIProvider;
        }
      }
    }

    // 2. Resolve user's active key for targetProvider
    const userKey = await prisma.userAIKey.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: targetProvider
        }
      }
    });

    // 3. Resolve preferred model for this provider if any
    const modelPref = await prisma.aIModelPreference.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: targetProvider
        }
      }
    });
    const preferredModel = modelPref?.selectedModel;

    // 4. If user has active key, decrypt and instantiate provider
    if (userKey && userKey.isActive && userKey.encryptedApiKey) {
      const decrypted = decrypt(userKey.encryptedApiKey);
      if (decrypted && decrypted.trim().length > 0) {
        const apiKey = decrypted.trim();
        const providerInstance = this.createProviderInstance(targetProvider, apiKey);

        return {
          provider: providerInstance,
          providerType: targetProvider,
          model: preferredModel,
          keyLast4: userKey.keyLast4,
          isPlatformFallback: false,
          userKeyId: userKey.id
        };
      }
    }

    // 5. If no user key, check if user is ADMIN and platform Gemini key fallback is permitted
    if (targetProvider === 'GEMINI') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true }
      });

      const isPlatformFallbackAllowed =
        process.env.PLATFORM_AI_FALLBACK_ENABLED === 'true' || user?.role === 'ADMIN';

      if (isPlatformFallbackAllowed) {
        const platformKey = getPlatformGeminiKey();
        if (platformKey) {
          const keyLast4 = platformKey.length >= 4 ? platformKey.slice(-4) : '****';
          return {
            provider: new GeminiProvider(platformKey),
            providerType: 'GEMINI',
            model: preferredModel,
            keyLast4,
            isPlatformFallback: true
          };
        }
      }
    }

    // 6. No credentials available -> fail closed
    throw new AIProviderError(
      'AI_PROVIDER_NOT_CONFIGURED',
      `No active API key configured for ${targetProvider}. Please connect your ${targetProvider} API key in Settings.`,
      400,
      targetProvider
    );
  }

  private static createProviderInstance(provider: SupportedAIProvider, apiKey: string): AIProvider {
    switch (provider) {
      case 'GEMINI':
        return new GeminiProvider(apiKey);
      case 'OPENROUTER':
        return new OpenRouterProvider(apiKey);
      case 'XKIRO':
        return new XKiroProvider(apiKey);
      default:
        throw new AIProviderError(
          'AI_PROVIDER_NOT_CONFIGURED',
          `Unsupported AI provider: ${provider}`,
          400
        );
    }
  }
}
