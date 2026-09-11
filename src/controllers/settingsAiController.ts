import { Request, Response } from 'express';
import { OwnershipGuard } from '../utils/ownershipGuard';
import {
  AIProviderService,
  AIModelService,
  AIProviderError,
  SupportedAIProvider
} from '../services/ai';
import { PrismaClient } from '@prisma/client';
import { decrypt } from '../utils/crypto';

const prisma = new PrismaClient();

const VALID_PROVIDERS: SupportedAIProvider[] = ['GEMINI', 'OPENROUTER', 'XKIRO'];

function parseProvider(param?: string | string[] | undefined): SupportedAIProvider | null {
  if (!param) return null;
  const str = Array.isArray(param) ? param[0] : param;
  const upper = (str || '').toUpperCase();
  return VALID_PROVIDERS.includes(upper as SupportedAIProvider)
    ? (upper as SupportedAIProvider)
    : null;
}

/**
 * GET /api/settings/ai
 * Returns the current user's AI configuration across Gemini, OpenRouter, and xKiro.
 */
export const getAISettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const status = await AIProviderService.getAllProvidersStatus(user.userId);
    res.status(200).json(status);
  } catch (error: any) {
    console.error('[SettingsAI] Error fetching AI settings:', error?.message);
    res.status(500).json({ error: 'Failed to retrieve AI settings' });
  }
};

/**
 * Helper to save an API key for any provider
 */
async function handleSaveKey(req: Request, res: Response, provider: SupportedAIProvider): Promise<void> {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { apiKey, selectedModel, skipValidation } = req.body || {};

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 8) {
      res.status(400).json({
        error: `A valid ${provider} API key is required.`,
        code: 'INVALID_KEY'
      });
      return;
    }

    const result = await AIProviderService.saveKey({
      userId: user.userId,
      provider,
      apiKey: apiKey.trim(),
      selectedModel,
      skipValidation: Boolean(skipValidation)
    });

    res.status(200).json({
      success: true,
      message: `${provider} API key connected successfully.`,
      configured: true,
      keyLast4: result.keyLast4,
      provider: result.provider
    });
  } catch (error: any) {
    if (error instanceof AIProviderError) {
      res.status(error.status).json({
        error: error.message,
        code: error.code,
        provider: error.provider
      });
      return;
    }
    console.error(`[SettingsAI] Error saving ${provider} key:`, error?.message);
    res.status(500).json({ error: `Failed to save ${provider} API key.` });
  }
}

/**
 * POST /api/settings/ai/gemini
 */
export const saveGeminiKey = async (req: Request, res: Response): Promise<void> => {
  return handleSaveKey(req, res, 'GEMINI');
};

/**
 * POST /api/settings/ai/openrouter
 */
export const saveOpenRouterKey = async (req: Request, res: Response): Promise<void> => {
  return handleSaveKey(req, res, 'OPENROUTER');
};

/**
 * POST /api/settings/ai/xkiro
 */
export const saveXKiroKey = async (req: Request, res: Response): Promise<void> => {
  return handleSaveKey(req, res, 'XKIRO');
};

/**
 * Helper to remove an API key for any provider
 */
async function handleRemoveKey(req: Request, res: Response, provider: SupportedAIProvider): Promise<void> {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    await AIProviderService.removeKey(user.userId, provider);

    res.status(200).json({
      success: true,
      message: `${provider} API key removed successfully.`,
      provider
    });
  } catch (error: any) {
    console.error(`[SettingsAI] Error removing ${provider} key:`, error?.message);
    res.status(500).json({ error: `Failed to remove ${provider} API key.` });
  }
}

/**
 * DELETE /api/settings/ai/gemini
 */
export const removeGeminiKey = async (req: Request, res: Response): Promise<void> => {
  return handleRemoveKey(req, res, 'GEMINI');
};

/**
 * DELETE /api/settings/ai/openrouter
 */
export const removeOpenRouterKey = async (req: Request, res: Response): Promise<void> => {
  return handleRemoveKey(req, res, 'OPENROUTER');
};

/**
 * DELETE /api/settings/ai/xkiro
 */
export const removeXKiroKey = async (req: Request, res: Response): Promise<void> => {
  return handleRemoveKey(req, res, 'XKIRO');
};

/**
 * DELETE /api/settings/ai/:provider
 */
export const removeAIKey = async (req: Request, res: Response): Promise<void> => {
  const provider = parseProvider(req.params.provider);
  if (!provider) {
    res.status(400).json({ error: `Invalid AI provider: ${req.params.provider}` });
    return;
  }
  return handleRemoveKey(req, res, provider);
};

/**
 * POST /api/settings/ai/:provider/test
 * Tests the connection for a specific provider using the authenticated user's stored encrypted key.
 */
export const testAIConnection = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const provider = parseProvider(req.params.provider);
    if (!provider) {
      res.status(400).json({ error: `Invalid AI provider: ${req.params.provider}` });
      return;
    }

    const result = await AIProviderService.testConnection(user.userId, provider);

    res.status(200).json(result);
  } catch (error: any) {
    if (error instanceof AIProviderError) {
      res.status(error.status).json({
        connected: false,
        error: error.message,
        code: error.code,
        provider: error.provider
      });
      return;
    }
    console.error('[SettingsAI] Error testing connection:', error?.message);
    res.status(500).json({ connected: false, error: 'Connection test failed.' });
  }
};

/**
 * GET /api/settings/ai/:provider/models
 * Retrieves available models for the provider dynamically.
 */
export const getProviderModels = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const provider = parseProvider(req.params.provider);
    if (!provider) {
      res.status(400).json({ error: `Invalid AI provider: ${req.params.provider}` });
      return;
    }

    const userKey = await prisma.userAIKey.findUnique({
      where: {
        userId_provider: {
          userId: user.userId,
          provider
        }
      }
    });

    const apiKey = userKey?.encryptedApiKey ? decrypt(userKey.encryptedApiKey) : '';
    const models = await AIModelService.getModels(provider, apiKey);

    res.status(200).json({
      provider,
      models
    });
  } catch (error: any) {
    console.error('[SettingsAI] Error fetching models:', error?.message);
    res.status(500).json({ error: 'Failed to retrieve model catalog.' });
  }
};

/**
 * POST /api/settings/ai/preference
 * Updates user's default provider and selected model.
 */
export const saveAIPreference = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { provider, selectedModel, isDefault } = req.body || {};
    const parsed = parseProvider(provider);
    if (!parsed) {
      res.status(400).json({ error: `Invalid AI provider: ${provider}` });
      return;
    }

    await AIProviderService.savePreference({
      userId: user.userId,
      provider: parsed,
      selectedModel,
      isDefault: Boolean(isDefault)
    });

    res.status(200).json({
      success: true,
      message: 'AI preferences updated successfully.',
      provider: parsed,
      selectedModel,
      isDefault
    });
  } catch (error: any) {
    console.error('[SettingsAI] Error saving preference:', error?.message);
    res.status(500).json({ error: 'Failed to update AI preferences.' });
  }
};
