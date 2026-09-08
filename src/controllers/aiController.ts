import { Request, Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';

// Fallback: read GEMINI_API_KEY directly from .env if process.env is missing it
// (needed because dotenvx sometimes skips injection)
function getGeminiKey(): string {
  let key = (process.env.GEMINI_API_KEY || '').replace(/^\"|\"$/g, '').trim();
  if (!key) {
    try {
      const envPath = path.resolve(__dirname, '../../.env');
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const match = envContent.match(/^GEMINI_API_KEY=["']?([^"'\r\n]+)["']?/m);
      if (match && match[1]) key = match[1].trim();
    } catch (_) {}
  }
  return key;
}


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
    const { instruction, context } = req.body;

    if (!instruction) {
      res.status(400).json({ error: 'Instruction is required.' });
      return;
    }

    // Strip any stray surrounding quotes from the env var (in case .env was saved with quotes)
    const rawKey = getGeminiKey();

    if (!rawKey) {
      res.status(500).json({ error: 'GEMINI_API_KEY is missing in backend/.env — please add your Gemini API key.' });
      return;
    }

    // Initialize lazily so a bad key doesn't crash the server at startup
    const ai = new GoogleGenAI({ apiKey: rawKey });

    const userPrompt = `
Instruction: ${instruction}

Campaign Context:
${context || 'Company: TripGain\nProduct: Business Travel & Expense Management\nTarget: SME decision makers\nGoal: Start a conversation\nTone: Professional, concise\nCTA: Quick conversation'}
    `;

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    let response: any;
    const models = [
      'gemini-flash-lite-latest',
      'gemini-flash-latest',
      'gemini-3.5-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
    ];
    let lastError: any;

    for (const model of models) {
      try {
        response = await ai.models.generateContent({
          model,
          contents: userPrompt,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 0.7,
            maxOutputTokens: 2048,
          }
        });
        if (response?.text) {
          break; // success — exit loop immediately
        }
      } catch (err: any) {
        lastError = err;
        const msg = err?.message || '';
        console.warn(`Model ${model} failed (${err?.status || err?.code || 'error'}): ${msg.slice(0, 120)}. Trying fallback model...`);
      }
    }

    if (!response) {
      throw lastError || new Error('All models unavailable');
    }

    const generatedText = response.text || '';

    // Some cleanup in case the AI added markdown blocks like ```html or ```text
    let cleanedText = generatedText.replace(/^```[a-z]*\n/gi, '').replace(/```$/g, '').trim();

    // Auto balance any unclosed Handlebars tags
    cleanedText = autoBalanceHandlebars(cleanedText);

    res.status(200).json({ template: cleanedText });
  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error('Error generating template:', msg);
    res.status(500).json({ error: 'Failed to generate template', detail: msg });
  }
};
