import { Request, Response } from 'express';
import { OwnershipGuard } from '../utils/ownershipGuard';
import { AIProviderService, AIProviderError } from '../services/aiProviderService';

const SYSTEM_PROMPT = `You are an AI email template generator for TripGain SME Outreach.

Your job is to create professional B2B cold email templates using ONLY the variables provided.

AVAILABLE VARIABLES:

Contact:
{{firstName}}
{{lastName}}
{{email}}
{{title}}
{{personLinkedinUrl}}
{{city}}

Company:
{{companyName}}
{{website}}
{{industry}}
{{companySize}}
{{companyPhone}}

Personalization:
{{personalization}}

Sender:
{{senderName}}
{{senderCompany}}

TEMPLATE SYNTAX:

Normal variable:
{{variable}}

Conditional:
{{#if variable}}
content when variable exists
{{else}}
fallback content
{{/if}}

Nested conditions are allowed.

RULES:

1. Never invent variables.
2. Only use variables from the approved variable list.
3. Use {{#if}} when a missing variable would make the sentence awkward.
4. Always provide a natural fallback for important personalization variables.
5. Do not expose conditional syntax in the final rendered email.
6. Do not use "undefined", "null", "N/A", or empty placeholders.
7. firstName should normally fallback to "there".
8. companyName should normally fallback to "your company".
9. title should have a natural fallback sentence.
10. personalization should have a complete fallback paragraph.
11. industry and companySize should be optional.
12. city should be optional.
13. Do not force optional variables into sentences.
14. Avoid repetitive use of companyName.
15. Keep the email concise and conversational.
16. Avoid exaggerated claims.
17. Do not make unsupported claims about customers, results, savings, or competitors.
18. Include a clear but low-pressure CTA.
19. Use <strong>...</strong> for important information that should appear bold.
20. Do not use Markdown bold syntax.
21. Return ONLY the email template. No explanation.
22. CRITICAL SYNTAX: Every single {{#if ...}} block MUST have a matching closing {{/if}} tag. Never leave an open {{#if}} block under any circumstances.`;

function autoBalanceHandlebars(template: string): string {
  if (!template) return '';
  let result = template;
  const blocks = ['if', 'unless', 'each', 'with'];
  for (const block of blocks) {
    const openMatches = result.match(new RegExp(`\\{\\{#${block}\\b[^}]*\\}\\}`, 'g')) || [];
    const closeMatches = result.match(new RegExp(`\\{\\{/${block}\\}\\}`, 'g')) || [];
    const diff = openMatches.length - closeMatches.length;
    if (diff > 0) {
      result = result.trimEnd() + '\n' + `{{/${block}}}\n`.repeat(diff).trimEnd();
    }
  }
  return result;
}

export const generateTemplate = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = OwnershipGuard.requireUser(req, res);
    if (!user) return;

    const { instruction, context } = req.body;

    if (!instruction) {
      res.status(400).json({ error: 'Instruction is required.' });
      return;
    }

    const userPrompt = `
Instruction: ${instruction}

Campaign Context:
${context || 'Company: TripGain\nProduct: Business Travel & Expense Management\nTarget: SME decision makers\nGoal: Start a conversation\nTone: Professional, concise\nCTA: Quick conversation'}
    `;

    const aiResult = await AIProviderService.generateText({
      userId: user.userId,
      feature: 'EMAIL_GENERATION',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.7,
      maxOutputTokens: 2048
    });

    const generatedText = aiResult.text || '';

    // Cleanup code fence blocks if any
    let cleanedText = generatedText.replace(/^```[a-z]*\n/gi, '').replace(/```$/g, '').trim();

    // Auto balance any unclosed Handlebars tags
    cleanedText = autoBalanceHandlebars(cleanedText);

    res.status(200).json({
      template: cleanedText,
      provider: aiResult.provider,
      keyLast4: aiResult.keyLast4
    });
  } catch (error: any) {
    if (error instanceof AIProviderError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    const msg = error?.message || String(error);
    console.error('Error generating template:', msg);
    res.status(500).json({ error: 'Failed to generate template', detail: msg });
  }
};
