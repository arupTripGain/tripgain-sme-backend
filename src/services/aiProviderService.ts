// Re-export from the new centralized provider-agnostic AI architecture
export {
  AIProviderService,
  AIProviderError,
  AIProviderResolver,
  AIModelService,
  AIUsageLimitService
} from './ai';

export interface AIProviderCredentials {
  type: 'GEMINI_USER' | 'GEMINI_PLATFORM';
  apiKey: string;
  keyLast4: string;
  userKeyId?: string;
}
