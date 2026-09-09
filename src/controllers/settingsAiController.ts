import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OwnershipGuard } from '../utils/ownershipGuard';
import { AIProviderService, AIProviderError } from '../services/aiProviderService';
import { encrypt } from '../utils/crypto';

const prisma = new PrismaClient();

/**
 * GET /api/settings/ai
 * Returns the current user's AI configuration status without exposing sensitive credentials.
 */
export const getAISettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const status = await AIProviderService.getUserAIStatus(user.userId);
    res.status(200).json(status);
  } catch (error: any) {
    console.error('[SettingsAI] Error fetching AI settings:', error?.message);
    res.status(500).json({ error: 'Failed to retrieve AI settings' });
  }
};

/**
 * POST /api/settings/ai/gemini
 * Connects or updates a user's encrypted Gemini API key.
 */
export const saveGeminiKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { apiKey, skipValidation } = req.body || {};

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 15) {
      res.status(400).json({ error: 'A valid Gemini API key is required.', code: 'INVALID_KEY' });
      return;
    }

    const trimmedKey = apiKey.trim();

    // Validate key against Gemini API unless explicitly skipped (for testing/mocking)
    if (!skipValidation) {
      try {
        await AIProviderService.validateGeminiKey(trimmedKey);
      } catch (validationErr: any) {
        if (validationErr instanceof AIProviderError) {
          res.status(validationErr.status).json({
            error: validationErr.message,
            code: validationErr.code
          });
          return;
        }
        res.status(400).json({ error: 'Unable to validate Gemini API key.' });
        return;
      }
    }

    // Encrypt key and isolate at rest
    const encryptedApiKey = encrypt(trimmedKey);
    const keyLast4 = trimmedKey.slice(-4);

    await prisma.userAIKey.upsert({
      where: { userId: user.userId },
      create: {
        userId: user.userId,
        provider: 'GEMINI',
        encryptedApiKey,
        keyLast4,
        isActive: true
      },
      update: {
        provider: 'GEMINI',
        encryptedApiKey,
        keyLast4,
        isActive: true,
        updatedAt: new Date()
      }
    });

    res.status(200).json({
      success: true,
      message: 'Gemini API key connected successfully.',
      configured: true,
      keyLast4,
      provider: 'GEMINI'
    });
  } catch (error: any) {
    console.error('[SettingsAI] Error saving Gemini key:', error?.message);
    res.status(500).json({ error: 'Failed to save Gemini API key.' });
  }
};

/**
 * DELETE /api/settings/ai/gemini
 * Disconnects and deletes a user's encrypted Gemini API key.
 */
export const removeGeminiKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    await prisma.userAIKey.deleteMany({
      where: { userId: user.userId }
    });

    res.status(200).json({
      success: true,
      message: 'Gemini API key removed successfully.'
    });
  } catch (error: any) {
    console.error('[SettingsAI] Error removing Gemini key:', error?.message);
    res.status(500).json({ error: 'Failed to remove Gemini API key.' });
  }
};
