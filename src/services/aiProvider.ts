export interface AiProvider {
  generateEmail(template: string, leadData: Record<string, any>, context?: string): Promise<string>;
  generatePersonalization(leadData: Record<string, any>): Promise<string>;
  classifyReply(messageBody: string): Promise<{ category: string; confidence: number }>;
}

export class DefaultAiProvider implements AiProvider {
  // In a real application, this would call OpenAI, Anthropic, etc.
  // For now, we simulate the AI processing with simple replacements.
  
  async generateEmail(template: string, leadData: Record<string, any>, context?: string): Promise<string> {
    let output = template;
    
    // Basic {{variable}} replacement simulation
    if (leadData) {
      for (const [key, value] of Object.entries(leadData)) {
        if (value) {
          const regex = new RegExp(`{{${key}}}`, 'gi');
          output = output.replace(regex, String(value));
        }
      }
    }
    
    return Promise.resolve(output);
  }

  async generatePersonalization(leadData: Record<string, any>): Promise<string> {
    if (leadData.company) {
      return `Loved learning about the recent initiatives at ${leadData.company}.`;
    }
    return `Hope you're having a great week.`;
  }

  async classifyReply(messageBody: string): Promise<{ category: string; confidence: number }> {
    const lower = messageBody.toLowerCase();
    
    if (lower.includes('unsubscribe') || lower.includes('remove me')) {
      return { category: 'UNSUBSCRIBE', confidence: 0.95 };
    }
    
    if (lower.includes('not interested') || lower.includes('no thanks')) {
      return { category: 'NOT_INTERESTED', confidence: 0.85 };
    }
    
    if (lower.includes('interested') || lower.includes('let\'s talk') || lower.includes('tell me more')) {
      return { category: 'INTERESTED', confidence: 0.8 };
    }
    
    if (lower.includes('out of office') || lower.includes('ooo')) {
      return { category: 'OUT_OF_OFFICE', confidence: 0.99 };
    }
    
    return { category: 'OTHER', confidence: 0.5 };
  }
}
