import { PrismaClient } from '@prisma/client';
import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import { ResearchService } from './researchService';

const prisma = new PrismaClient();

function getGeminiKey(): string {
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

export interface GenerationResult {
  success: boolean;
  personalization: string | null;
  status: 'GENERATED' | 'NO_USEFUL_DATA' | 'FAILED';
  source: 'AI_RESEARCH' | 'MANUAL';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  evidence?: any | undefined;
  reason?: string | undefined;
}

export class PersonalizationValidator {
  private static FORBIDDEN_CLICHES = [
    'impressed by',
    'impressive growth',
    'congratulations on',
    'game-changing',
    'game changer',
    'revolutionary',
    'industry-leading',
    'leading provider',
    'innovative approach',
    'innovative work',
    'exciting journey',
    'doing amazing work',
    'caught my attention',
    'came across your profile',
    'researched your company',
    'according to my research',
    'as an ai',
    'in today\'s fast-paced'
  ];

  private static FORBIDDEN_TOKENS = [
    '{{',
    '}}',
    'undefined',
    'null',
    '[company]',
    '[name]',
    '[first name]',
    'n/a',
    'no_useful_personalization'
  ];

  private static UNSUPPORTED_ASSUMPTIONS = [
    'travel frequently',
    'travels frequently',
    'frequent traveler',
    'fly constantly',
    'spend a lot on flights',
    'your heavy travel schedule'
  ];

  static validate(text: string): { isValid: boolean; reason?: string } {
    if (!text || text.trim() === '') {
      return { isValid: false, reason: 'Empty text' };
    }

    const trimmed = text.trim();

    if (trimmed.toUpperCase() === 'NO_USEFUL_PERSONALIZATION') {
      return { isValid: false, reason: 'NO_USEFUL_PERSONALIZATION returned' };
    }

    // Check forbidden tokens/placeholders
    const lower = trimmed.toLowerCase();
    for (const token of this.FORBIDDEN_TOKENS) {
      if (lower.includes(token)) {
        return { isValid: false, reason: `Contains invalid placeholder or variable: ${token}` };
      }
    }

    // Check forbidden clichés
    for (const cliche of this.FORBIDDEN_CLICHES) {
      if (lower.includes(cliche)) {
        return { isValid: false, reason: `Contains generic praise or marketing cliché: "${cliche}"` };
      }
    }

    // Check unsupported assumptions
    for (const assumption of this.UNSUPPORTED_ASSUMPTIONS) {
      if (lower.includes(assumption)) {
        return { isValid: false, reason: `Asserts unsupported assumption as fact: "${assumption}"` };
      }
    }

    // Sentence count check: 1 to 2 sentences
    // Match sentence-ending punctuation followed by space or end of string
    const sentenceMatches = trimmed.match(/[^.!?]+[.!?]+(\s|$)/g) || [trimmed];
    if (sentenceMatches.length > 3) {
      return { isValid: false, reason: `Too many sentences (${sentenceMatches.length}). Target is 1–2 sentences.` };
    }

    // Word count check: between 15 and 65 words
    const words = trimmed.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 10) {
      return { isValid: false, reason: `Too short (${words.length} words). Target is 25–50 words.` };
    }
    if (words.length > 65) {
      return { isValid: false, reason: `Too long (${words.length} words). Target is 25–50 words.` };
    }

    return { isValid: true };
  }
}

export class PersonalizationService {
  /**
   * Generates personalization for a single contact by contactId.
   * If force = false and existing source is 'MANUAL', preserves manual edit.
   */
  static async generateForContact(contactId: string, force = false): Promise<GenerationResult> {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: { organization: true, emails: true }
    });

    if (!contact) {
      return {
        success: false,
        personalization: null,
        status: 'FAILED',
        source: 'AI_RESEARCH',
        confidence: 'LOW',
        reason: 'Contact not found'
      };
    }

    // Protect manual edits unless explicitly forced (e.g. user clicked Regenerate)
    if (!force && contact.personalizationSource === 'MANUAL' && contact.personalizedLine) {
      return {
        success: true,
        personalization: contact.personalizedLine,
        status: (contact.personalizationStatus as any) || 'GENERATED',
        source: 'MANUAL',
        confidence: (contact.personalizationConfidence as any) || 'HIGH',
        evidence: contact.personalizationEvidence,
        reason: 'Protected manual edit'
      };
    }

    // Mark as GENERATING
    await prisma.contact.update({
      where: { id: contactId },
      data: { personalizationStatus: 'GENERATING' }
    });

    const result = await this.executeGeneration(contact);

    // Save result to contact
    const updateData: any = {
      personalizedLine: result.personalization,
      personalizationStatus: result.status,
      personalizationSource: 'AI_RESEARCH',
      personalizationConfidence: result.confidence,
      personalizationGeneratedAt: new Date(),
      personalizationUpdatedAt: new Date()
    };
    if (result.evidence) {
      updateData.personalizationEvidence = result.evidence;
    }

    await prisma.contact.update({
      where: { id: contactId },
      data: updateData
    });

    return result;
  }

  /**
   * Core logic: gathers research, calls LLM, validates, returns structured result.
   */
  private static async executeGeneration(contact: any): Promise<GenerationResult> {
    const company = contact.organization;
    const companyName = company?.name || '';
    const website = company?.domain || company?.websiteUrl || '';
    const industry = company?.industry || '';
    const companySize = company?.employeeSize || '';
    const companyPhone = company?.phone || '';
    const firstName = contact.firstName || '';
    const lastName = contact.lastName || '';
    const title = contact.jobTitle || '';
    const city = contact.city || '';
    const personLinkedinUrl = contact.linkedinUrl || '';
    const primaryEmail = contact.emails?.find((e: any) => e.isPrimary)?.email || contact.emails?.[0]?.email || '';

    // Check if we have minimum viable information
    if (!companyName && !industry && !title) {
      return {
        success: false,
        personalization: null,
        status: 'NO_USEFUL_DATA',
        source: 'AI_RESEARCH',
        confidence: 'LOW',
        reason: 'Insufficient prospect data'
      };
    }

    // Step 1: Research public sources
    const research = await ResearchService.researchTarget({
      companyName,
      website,
      industry,
      jobTitle: title,
      fullName: contact.fullName
    });

    const rawKey = getGeminiKey();
    if (!rawKey) {
      return {
        success: false,
        personalization: null,
        status: 'FAILED',
        source: 'AI_RESEARCH',
        confidence: 'LOW',
        reason: 'GEMINI_API_KEY is not configured on the server'
      };
    }

    const ai = new GoogleGenAI({ apiKey: rawKey });

    const systemPrompt = `You are generating personalization for a B2B cold email on behalf of TripGain.

TripGain Value Proposition: Corporate travel booking, approvals, and expense management in one unified platform for growing SMEs.

Your goal:
Create a natural 1–2 sentence personalization (approx. 25–50 words) using verified information about the prospect or company.
Identify one specific business fact or core offering from the company profile or research signals.
Connect that observation naturally to business travel, client operations, or expense management by suggesting curiosity or potential relevance.

Good examples:
- "I noticed that Ryzklytix works across risk management and system integration for banking and insurance, which made me curious about how your team currently manages travel for client projects."
- "I came across your work in helping financial institutions with risk-management solutions and thought the travel-management side of your operations might be relevant."
- "I noticed your team delivers specialized technical solutions across client engagements, which made me curious how you currently handle travel and expense workflows."

Rules:
1. Do not invent facts, revenue, funding, or employee counts.
2. Do not state assumptions as facts (do NOT say "your team travels frequently"; instead suggest curiosity e.g. "curious about how your team manages business travel for client projects").
3. Do not flatter the prospect. Avoid generic praise like "impressive", "amazing", "congratulations", "innovative".
4. Do not mention that research was performed (do not say "I researched your company", "I was looking at your website", or "AI").
5. Do not use marketing clichés ("game-changing", "revolutionary", "industry-leading", "exciting journey").
6. Length: exactly 1–2 sentences, approx. 25–50 words.
7. Return ONLY the personalization text.
8. Only if there is no verifiable company, role, or industry information, return:
NO_USEFUL_PERSONALIZATION`;

    const userPrompt = `
PERSON:
First Name: ${firstName || 'Unknown'}
Last Name: ${lastName || ''}
Title/Role: ${title || 'Leader'}
LinkedIn: ${personLinkedinUrl || 'N/A'}
City: ${city || 'N/A'}
Email: ${primaryEmail || 'N/A'}

COMPANY:
Company Name: ${companyName || 'Unknown'}
Website: ${website || 'N/A'}
Industry: ${industry || 'N/A'}
Company Size: ${companySize || 'N/A'}
Company Phone: ${companyPhone || 'N/A'}

PUBLIC RESEARCH SIGNALS:
${research.extractedSignals.length > 0 ? research.extractedSignals.join('\n') : 'No website content extracted.'}

CAMPAIGN CONTEXT:
Product: TripGain Business Travel & Expense Management
Value proposition: Booking, approvals, travel management and automated expense reporting in one place.
Target: SMEs with business travel requirements.
`;

    const models = [
      'gemini-flash-lite-latest',
      'gemini-flash-latest',
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-2.5-flash'
    ];

    let rawGeneratedText = '';
    let lastError: any;

    for (const model of models) {
      try {
        const resp: any = await ai.models.generateContent({
          model,
          contents: userPrompt,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.4,
            maxOutputTokens: 250,
          }
        });
        if (resp?.text) {
          rawGeneratedText = resp.text.trim();
          break;
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`[PersonalizationService] Model ${model} error:`, err?.message?.slice(0, 100));
      }
    }

    if (!rawGeneratedText) {
      console.error('[PersonalizationService] Failed to generate personalization:', lastError?.message);
      return {
        success: false,
        personalization: null,
        status: 'FAILED',
        source: 'AI_RESEARCH',
        confidence: 'LOW',
        reason: lastError?.message || 'AI generation failed'
      };
    }

    // Clean markdown code fence if model returned it
    let cleaned = rawGeneratedText.replace(/^```[a-z]*\n?/gi, '').replace(/```$/g, '').trim();
    // Remove outer quotation marks if wrapped in quotes
    cleaned = cleaned.replace(/^["']|["']$/g, '').trim();

    if (cleaned.toUpperCase() === 'NO_USEFUL_PERSONALIZATION') {
      return {
        success: false,
        personalization: null,
        status: 'NO_USEFUL_DATA',
        source: 'AI_RESEARCH',
        confidence: 'LOW',
        evidence: research.extractedSignals,
        reason: 'AI determined insufficient reliable signals'
      };
    }

    // Quality check
    const validation = PersonalizationValidator.validate(cleaned);
    if (!validation.isValid) {
      console.warn('[PersonalizationService] Quality validation failed:', validation.reason, 'Text:', cleaned);
      return {
        success: false,
        personalization: null,
        status: validation.reason?.includes('NO_USEFUL_PERSONALIZATION') ? 'NO_USEFUL_DATA' : 'FAILED',
        source: 'AI_RESEARCH',
        confidence: 'LOW',
        evidence: { signals: research.extractedSignals, candidate: cleaned },
        reason: validation.reason || 'Quality validation failed'
      };
    }

    // Determine confidence: HIGH if website research signals were matched, MEDIUM if industry/role matched
    const confidence = research.websiteSummary || research.headings?.length ? 'HIGH' : 'MEDIUM';

    return {
      success: true,
      personalization: cleaned,
      status: 'GENERATED',
      source: 'AI_RESEARCH',
      confidence,
      evidence: {
        signals: research.extractedSignals,
        sourceUrl: research.sourceUrl
      }
    };
  }

  /**
   * Manually updates personalization for a contact.
   * Marks source as MANUAL to protect it from automatic regeneration.
   */
  static async updateManualPersonalization(contactId: string, text: string): Promise<any> {
    const trimmed = text.trim();
    const updated = await prisma.contact.update({
      where: { id: contactId },
      data: {
        personalizedLine: trimmed || null,
        personalizationStatus: trimmed ? 'GENERATED' : 'PENDING',
        personalizationSource: 'MANUAL',
        personalizationConfidence: trimmed ? 'HIGH' : null,
        personalizationUpdatedAt: new Date()
      },
      include: {
        organization: true,
        emails: true
      }
    });

    return updated;
  }
}
