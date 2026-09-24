import { parse as csvParse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { fetchPublicUrl, FetchedWebContent } from './urlFetcherService';
import { classifyPage } from './pageClassifier';
import { extractFromDirectory, parseDetailPageHtml, mapJsonRecordToLead } from './directoryExtractor';
import { renderPageWithPlaywright } from './playwrightService';

export interface ExtractedRawLead {
  rowNumber?: number | undefined;
  rawText?: string | undefined;
  rawData?: Record<string, any> | undefined;
  rawName?: string | undefined;
  companyName?: string | undefined;
  boothNumber?: string | null | undefined;
  hallNumber?: string | null | undefined;
  category?: string | null | undefined;
  detailUrl?: string | null | undefined;
  sourceUrl?: string | null | undefined;
  contactName?: string | null | undefined;
  contactTitle?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  websiteUrl?: string | null | undefined;
  domain?: string | null | undefined;
  industry?: string | null | undefined;
  companySize?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  country?: string | null | undefined;
  address?: string | null | undefined;
  linkedinUrl?: string | null | undefined;
  provenance: {
    sourceType: string;
    sourceName: string;
    rowNumber?: number | undefined;
    pageNumber?: number | undefined;
    url?: string | undefined;
    extractedFields: string[];
  };
}

export interface ExtractionResult {
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'NEEDS_OCR';
  leads: ExtractedRawLead[];
  rawRecords: Array<{
    rowNumber?: number | undefined;
    rawText?: string | undefined;
    rawData?: any;
    parseStatus: 'PARSED' | 'FAILED' | 'NEEDS_OCR';
    errorMessage?: string | undefined;
  }>;
  totalRecords: number;
  errorMessage?: string | undefined;
  metrics?: any;
  pageType?: string;
}

import { ProgressCallback, CheckCancelledCallback } from './paginationEngine';

export interface WebsiteExtractOptions {
  maxRecords?: number | undefined;
  maxDetailPages?: number | undefined;
  maxRequests?: number | undefined;
  maxPages?: number | undefined;
  allowLoopback?: boolean | undefined;
  mode?: 'sample' | 'limited' | 'all' | undefined;
  onProgress?: ProgressCallback | undefined;
  checkCancelled?: CheckCancelledCallback | undefined;
}

// Deterministic header aliases map
const FIELD_ALIASES: Record<string, string[]> = {
  companyName: [
    'company', 'company name', 'company_name', 'companyname', 'organization', 'org',
    'organization name', 'account', 'business', 'business name', 'employer', 'firm', 'client'
  ],
  contactName: [
    'contact', 'contact name', 'contact_name', 'full name', 'fullname', 'name',
    'person', 'lead name', 'individual', 'first and last name', 'contact person'
  ],
  contactTitle: [
    'title', 'job title', 'job_title', 'designation', 'role', 'position', 'function', 'headline'
  ],
  email: [
    'email', 'e-mail', 'mail', 'email address', 'contact email', 'work email',
    'primary email', 'business email'
  ],
  phone: [
    'phone', 'telephone', 'mobile', 'cell', 'phone number', 'contact number',
    'tel', 'work phone', 'office phone'
  ],
  websiteUrl: [
    'website', 'web', 'url', 'site', 'domain', 'homepage', 'company url',
    'company website', 'website url', 'web site'
  ],
  industry: [
    'industry', 'sector', 'vertical', 'business type', 'category', 'segment'
  ],
  companySize: [
    'size', 'company size', 'employees', 'headcount', 'team size', 'employee count',
    'staff count', 'number of employees'
  ],
  city: [
    'city', 'location', 'metro', 'town', 'headquarters city', 'hq city'
  ],
  state: [
    'state', 'province', 'region'
  ],
  country: [
    'country', 'nation'
  ],
  address: [
    'address', 'street', 'office address', 'full address', 'hq address'
  ],
  linkedinUrl: [
    'linkedin', 'linkedin url', 'linkedin profile', 'linkedin_url', 'company linkedin'
  ],
};

/**
 * Maps arbitrary header names to standardized Lead Intelligence fields using the alias dictionary.
 */
export function mapHeadersToFields(headers: string[]): Record<number, string> {
  const mapping: Record<number, string> = {};

  headers.forEach((h, idx) => {
    if (!h) return;
    const clean = h.toString().toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
    
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (aliases.some(alias => clean === alias || clean.includes(alias))) {
        mapping[idx] = field;
        break;
      }
    }
  });

  return mapping;
}

/**
 * Extracts leads from CSV text or Buffer
 */
export function extractFromCsv(
  bufferOrString: Buffer | string,
  sourceName: string
): ExtractionResult {
  const content = Buffer.isBuffer(bufferOrString) ? bufferOrString.toString('utf-8') : bufferOrString;

  // Detect delimiter: comma, tab, semicolon
  const sample = content.slice(0, 2000);
  const commas = (sample.match(/,/g) || []).length;
  const tabs = (sample.match(/\t/g) || []).length;
  const semicolons = (sample.match(/;/g) || []).length;
  
  let delimiter = ',';
  if (tabs > commas && tabs > semicolons) {
    delimiter = '\t';
  } else if (semicolons > commas && semicolons > tabs) {
    delimiter = ';';
  }

  let records: string[][] = [];
  try {
    records = csvParse(content, {
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
  } catch (err: any) {
    return {
      status: 'FAILED',
      leads: [],
      rawRecords: [],
      totalRecords: 0,
      errorMessage: `Failed to parse CSV: ${err.message}`,
    };
  }

  if (records.length === 0) {
    return {
      status: 'FAILED',
      leads: [],
      rawRecords: [],
      totalRecords: 0,
      errorMessage: 'CSV file is empty.',
    };
  }

  // Row 0 is headers
  const headers = records[0];
  if (!headers) {
    return {
      status: 'FAILED',
      leads: [],
      rawRecords: [],
      totalRecords: 0,
      errorMessage: 'CSV has no header row.',
    };
  }
  const fieldMapping = mapHeadersToFields(headers);

  const leads: ExtractedRawLead[] = [];
  const rawRecords: ExtractionResult['rawRecords'] = [];

  for (let r = 1; r < records.length; r++) {
    const row = records[r];
    if (!row) continue;

    const rowData: Record<string, any> = {};
    const lead: Partial<ExtractedRawLead> = {
      rowNumber: r + 1,
      provenance: {
        sourceType: 'CSV',
        sourceName,
        rowNumber: r + 1,
        extractedFields: [],
      },
    };

    headers.forEach((h, idx) => {
      rowData[h || `col_${idx}`] = row[idx] || '';
    });

    for (const [colIdxStr, field] of Object.entries(fieldMapping)) {
      const colIdx = parseInt(colIdxStr, 10);
      const val = row[colIdx]?.trim();
      if (val) {
        (lead as any)[field] = val;
        lead.provenance!.extractedFields.push(field);
      }
    }

    // Company fallback if missing but website exists
    if (!lead.companyName && lead.websiteUrl) {
      const splitUrl = lead.websiteUrl.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').split('/');
      const dom = splitUrl[0] || '';
      lead.companyName = dom.split('.')[0] || 'Company';
      lead.provenance!.extractedFields.push('companyName');
    }

    const hasEssentialData = !!lead.companyName || !!lead.email || !!lead.websiteUrl || !!lead.phone;

    if (hasEssentialData) {
      leads.push(lead as ExtractedRawLead);
      rawRecords.push({
        rowNumber: r + 1,
        rawText: row.join(','),
        rawData: rowData,
        parseStatus: 'PARSED',
      });
    } else {
      rawRecords.push({
        rowNumber: r + 1,
        rawText: row.join(','),
        rawData: rowData,
        parseStatus: 'FAILED',
        errorMessage: 'Row lacked identifiable company name, domain, email, or phone',
      });
    }
  }

  return {
    status: leads.length > 0 ? 'COMPLETED' : 'FAILED',
    leads,
    rawRecords,
    totalRecords: records.length - 1,
  };
}

/**
 * Extracts leads from XLSX / XLS Buffer
 */
export function extractFromXlsx(
  buffer: Buffer,
  sourceName: string
): ExtractionResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err: any) {
    return {
      status: 'FAILED',
      leads: [],
      rawRecords: [],
      totalRecords: 0,
      errorMessage: `Failed to parse Excel file: ${err.message}`,
    };
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return {
      status: 'FAILED',
      leads: [],
      rawRecords: [],
      totalRecords: 0,
      errorMessage: 'Excel workbook contains no sheets.',
    };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return {
      status: 'FAILED',
      leads: [],
      rawRecords: [],
      totalRecords: 0,
      errorMessage: 'Excel workbook contains no sheets.',
    };
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return {
      status: 'FAILED',
      leads: [],
      rawRecords: [],
      totalRecords: 0,
      errorMessage: 'Excel sheet could not be read.',
    };
  }

  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const firstRow = rows[0];
  if (!firstRow || rows.length === 0) {
    return {
      status: 'FAILED',
      leads: [],
      rawRecords: [],
      totalRecords: 0,
      errorMessage: 'Excel sheet is empty.',
    };
  }

  const headers = firstRow.map((h: any) => String(h || ''));
  const fieldMapping = mapHeadersToFields(headers);

  const leads: ExtractedRawLead[] = [];
  const rawRecords: ExtractionResult['rawRecords'] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    // Skip completely empty rows
    if (!row || row.every((c: any) => String(c).trim() === '')) continue;

    const rowData: Record<string, any> = {};
    const lead: Partial<ExtractedRawLead> = {
      rowNumber: r + 1,
      provenance: {
        sourceType: 'XLSX',
        sourceName,
        rowNumber: r + 1,
        extractedFields: [],
      },
    };

    headers.forEach((h, idx) => {
      rowData[h || `col_${idx}`] = row[idx] !== undefined ? String(row[idx]).trim() : '';
    });

    for (const [colIdxStr, field] of Object.entries(fieldMapping)) {
      const colIdx = parseInt(colIdxStr, 10);
      const val = row[colIdx] !== undefined ? String(row[colIdx]).trim() : '';
      if (val) {
        (lead as any)[field] = val;
        lead.provenance!.extractedFields.push(field);
      }
    }

    if (!lead.companyName && lead.websiteUrl) {
      const splitUrl = lead.websiteUrl.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').split('/');
      const dom = splitUrl[0] || '';
      lead.companyName = dom.split('.')[0] || 'Company';
      lead.provenance!.extractedFields.push('companyName');
    }

    const hasEssentialData = !!lead.companyName || !!lead.email || !!lead.websiteUrl || !!lead.phone;

    if (hasEssentialData) {
      leads.push(lead as ExtractedRawLead);
      rawRecords.push({
        rowNumber: r + 1,
        rawText: row.join('\t'),
        rawData: rowData,
        parseStatus: 'PARSED',
      });
    } else {
      rawRecords.push({
        rowNumber: r + 1,
        rawText: row.join('\t'),
        rawData: rowData,
        parseStatus: 'FAILED',
        errorMessage: 'Row lacked identifiable company name, domain, email, or phone',
      });
    }
  }

  return {
    status: leads.length > 0 ? 'COMPLETED' : 'FAILED',
    leads,
    rawRecords,
    totalRecords: leads.length + (rawRecords.length - leads.length),
  };
}

/**
 * Extracts leads from PDF Buffer
 * If PDF has no extractable text (e.g. scanned image), strictly returns status: 'NEEDS_OCR'
 */
export async function extractFromPdf(
  buffer: Buffer,
  sourceName: string
): Promise<ExtractionResult> {
  let data: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse');
    data = await pdfParse(buffer);
  } catch (err: any) {
    return {
      status: 'NEEDS_OCR',
      leads: [],
      rawRecords: [
        {
          rawText: '(Scanned or image-only PDF stream)',
          parseStatus: 'NEEDS_OCR',
          errorMessage: `Needs OCR: ${err.message}`,
        },
      ],
      totalRecords: 1,
      errorMessage: `Needs OCR: Scanned or image-only PDF. Phase 1 supports text-based PDFs only. (${err.message})`,
    };
  }

  const rawText = data.text ? data.text.trim() : '';

  // Rule 9: If PDF appears to be scanned/image-only (< 20 characters of text), return "Needs OCR"
  if (!rawText || rawText.length < 20) {
    return {
      status: 'NEEDS_OCR',
      leads: [],
      rawRecords: [
        {
          rawText: rawText || '(Empty / Scanned PDF)',
          parseStatus: 'NEEDS_OCR',
          errorMessage: 'Document contains no extractable text. Scanned images or rasterized PDFs require OCR processing.',
        },
      ],
      totalRecords: 1,
      errorMessage: 'Needs OCR: Scanned or image-only PDF. Phase 1 supports text-based PDFs only.',
    };
  }

  // Parse lines/blocks from text-based PDF
  const lines = rawText.split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l.length > 0);
  const leads: ExtractedRawLead[] = [];
  const rawRecords: ExtractionResult['rawRecords'] = [];

  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
  const urlRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/g;

  // Attempt line-by-line or paragraph-level lead extraction
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    
    // Check if line contains tabular delimiters (e.g. tabs or multiple spaces)
    if (line.includes('\t') || line.includes(' | ')) {
      const parts = line.includes('\t') ? line.split('\t') : line.split(' | ');
      const cleanParts = parts.map((p: string) => p.trim()).filter(Boolean);
      const firstClean = cleanParts[0];
      if (cleanParts.length >= 2 && firstClean) {
        const lead: ExtractedRawLead = {
          rowNumber: i + 1,
          rawText: line,
          companyName: firstClean,
          provenance: {
            sourceType: 'PDF',
            sourceName,
            rowNumber: i + 1,
            extractedFields: ['companyName'],
          },
        };

        cleanParts.slice(1).forEach((part: string) => {
          if (part.includes('@') && !lead.email) {
            lead.email = part;
            lead.provenance.extractedFields.push('email');
          } else if (part.match(phoneRegex) && !lead.phone) {
            lead.phone = part;
            lead.provenance.extractedFields.push('phone');
          } else if ((part.includes('.com') || part.includes('http')) && !lead.websiteUrl) {
            lead.websiteUrl = part;
            lead.provenance.extractedFields.push('websiteUrl');
          }
        });

        leads.push(lead);
        rawRecords.push({
          rowNumber: i + 1,
          rawText: line,
          rawData: { parts: cleanParts },
          parseStatus: 'PARSED',
        });
        continue;
      }
    }

    // Check if line has email or phone
    const emails = line.match(emailRegex);
    const phones = line.match(phoneRegex);
    const urls = line.match(urlRegex);

    if (emails || phones || urls) {
      // Look back 1 line for company name if available
      const companyCandidate = (i > 0 && lines[i - 1].length < 80 && !lines[i - 1].match(emailRegex))
        ? lines[i - 1]
        : line.split(/[,;-]/)[0].trim();

      const lead: ExtractedRawLead = {
        rowNumber: i + 1,
        rawText: line,
        companyName: companyCandidate,
        email: emails ? emails[0] : undefined,
        phone: phones ? phones[0] : undefined,
        websiteUrl: urls ? urls[0] : undefined,
        provenance: {
          sourceType: 'PDF',
          sourceName,
          rowNumber: i + 1,
          extractedFields: ['companyName'],
        },
      };

      if (lead.email) lead.provenance.extractedFields.push('email');
      if (lead.phone) lead.provenance.extractedFields.push('phone');
      if (lead.websiteUrl) lead.provenance.extractedFields.push('websiteUrl');

      leads.push(lead);
      rawRecords.push({
        rowNumber: i + 1,
        rawText: line,
        rawData: { line, candidate: companyCandidate },
        parseStatus: 'PARSED',
      });
    }
  }

  // If no tabular leads found, record rawText as a single raw record
  if (leads.length === 0) {
    rawRecords.push({
      rowNumber: 1,
      rawText: rawText.slice(0, 5000),
      parseStatus: 'PARSED',
    });
  }

  return {
    status: leads.length > 0 ? 'COMPLETED' : 'PARTIAL',
    leads,
    rawRecords,
    totalRecords: Math.max(leads.length, 1),
  };
}

/**
 * Extracts leads from raw pasted text (CSV, TSV, or structured contact lines)
 */
export function extractFromPastedText(
  text: string,
  sourceName = 'Pasted Text'
): ExtractionResult {
  const clean = text.trim();
  if (!clean) {
    return {
      status: 'FAILED',
      leads: [],
      rawRecords: [],
      totalRecords: 0,
      errorMessage: 'Pasted text is empty.',
    };
  }

  // Check if pasted text resembles CSV or TSV (has commas or tabs)
  const lines = clean.split(/\r?\n/).filter(l => l.trim().length > 0);
  const commaCount = lines.slice(0, 5).reduce((acc, l) => acc + (l.match(/,/g) || []).length, 0);
  const tabCount = lines.slice(0, 5).reduce((acc, l) => acc + (l.match(/\t/g) || []).length, 0);

  if (commaCount >= 2 || tabCount >= 1) {
    return extractFromCsv(clean, sourceName);
  }

  // Otherwise, parse line-by-line contact blocks
  const leads: ExtractedRawLead[] = [];
  const rawRecords: ExtractionResult['rawRecords'] = [];

  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
  const urlRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/g;

  lines.forEach((line, idx) => {
    const emails = line.match(emailRegex);
    const phones = line.match(phoneRegex);
    const urls = line.match(urlRegex);

    let companyName = '';
    const segments = line.split(/[|\t,-]/).map(s => s.trim());
    const firstSeg = segments[0];
    if (firstSeg && firstSeg.length < 80) {
      companyName = firstSeg;
    } else {
      companyName = `Company ${idx + 1}`;
    }

    if (emails || phones || urls || segments.length > 1) {
      const lead: ExtractedRawLead = {
        rowNumber: idx + 1,
        rawText: line,
        companyName,
        email: emails ? emails[0] : undefined,
        phone: phones ? phones[0] : undefined,
        websiteUrl: urls ? urls[0] : undefined,
        provenance: {
          sourceType: 'PASTED_TEXT',
          sourceName,
          rowNumber: idx + 1,
          extractedFields: ['companyName'],
        },
      };

      if (lead.email) lead.provenance.extractedFields.push('email');
      if (lead.phone) lead.provenance.extractedFields.push('phone');
      if (lead.websiteUrl) lead.provenance.extractedFields.push('websiteUrl');

      leads.push(lead);
      rawRecords.push({
        rowNumber: idx + 1,
        rawText: line,
        rawData: { line },
        parseStatus: 'PARSED',
      });
    } else {
      rawRecords.push({
        rowNumber: idx + 1,
        rawText: line,
        parseStatus: 'FAILED',
        errorMessage: 'Line could not be mapped to lead fields',
      });
    }
  });

  return {
    status: leads.length > 0 ? 'COMPLETED' : 'FAILED',
    leads,
    rawRecords,
    totalRecords: lines.length,
  };
}

/**
 * Extracts company metadata from a public website URL, or runs Directory Extractor
 * if the page is classified as a DIRECTORY.
 */
export async function extractFromWebsite(
  url: string,
  sourceName = 'Website Research',
  options: WebsiteExtractOptions = {}
): Promise<ExtractionResult> {
  let webData: FetchedWebContent;
  try {
    webData = await fetchPublicUrl(url, { allowLoopback: options.allowLoopback });
  } catch (err: any) {
    return {
      status: 'FAILED',
      leads: [],
      rawRecords: [
        {
          rawText: url,
          parseStatus: 'FAILED',
          errorMessage: err.message,
        },
      ],
      totalRecords: 1,
      errorMessage: err.message,
    };
  }

  // Classify page
  const classification = classifyPage(webData.html, webData.finalUrl);
  if (classification.pageType === 'DIRECTORY') {
    return extractFromDirectory(url, options, sourceName);
  }

  const isSpaShell = 
    webData.html.includes('id="__next"') ||
    webData.html.includes('id="root"') ||
    webData.textContent.includes('Loading...') ||
    (webData.textContent.length < 300 && webData.html.includes('<script'));

  let dynamicLeadFields: Partial<ExtractedRawLead> = {};
  let renderedFinalUrl = webData.finalUrl;
  let parsedText = webData.textContent;

  if (isSpaShell || classification.pageType === 'DETAIL') {
    try {
      const rendered = await renderPageWithPlaywright(url, {
        allowLoopback: options.allowLoopback,
        maxRequests: options.maxRequests ?? 150,
        timeoutMs: 15000,
      });

      renderedFinalUrl = rendered.finalUrl;
      parsedText = rendered.html;
      dynamicLeadFields = parseDetailPageHtml(
        rendered.html,
        rendered.finalUrl,
        classification.organizerEmails,
        classification.organizerPhones
      );

      // Check captured JSON payloads from background data APIs
      if (rendered.capturedJsonPayloads.length > 0) {
        for (const payload of rendered.capturedJsonPayloads) {
          const items = Array.isArray(payload.data) ? payload.data : [payload.data];
          for (const item of items) {
            const mapped = mapJsonRecordToLead(item, payload.url, url, classification.organizerEmails);
            if (mapped && mapped.companyName) {
              for (const [k, v] of Object.entries(mapped)) {
                if (v !== undefined && v !== null && v !== '') {
                  (dynamicLeadFields as any)[k] = v;
                }
              }
              break;
            }
          }
        }
      }
    } catch (err: any) {
      console.warn('Playwright detail rendering fallback encountered error, proceeding with static data:', err.message);
    }
  }

  // Derive company name
  let companyName = dynamicLeadFields.companyName || webData.title || '';
  if (companyName.includes(' - ')) {
    companyName = companyName.split(' - ')[0] || '';
  } else if (companyName.includes(' | ')) {
    companyName = companyName.split(' | ')[0] || '';
  } else if (companyName.includes(': ')) {
    companyName = companyName.split(': ')[0] || '';
  }
  companyName = companyName.trim();

  // Fallback to domain if title was generic or empty
  const parsedUrl = new URL(renderedFinalUrl);
  const domain = dynamicLeadFields.domain || parsedUrl.hostname.replace(/^www\./i, '');
  if (!companyName || companyName.length > 60 || companyName.toLowerCase().includes('welcome to')) {
    const rawDom = domain.split('.')[0] || 'Company';
    companyName = rawDom.charAt(0).toUpperCase() + rawDom.slice(1);
  }

  // Filter out any organizer emails or phones
  const validEmails = [
    ...(dynamicLeadFields.email ? [dynamicLeadFields.email] : []),
    ...webData.extractedEmails.filter(e => !classification.organizerEmails.includes(e.toLowerCase())),
  ];
  const validPhones = [
    ...(dynamicLeadFields.phone ? [dynamicLeadFields.phone] : []),
    ...webData.extractedPhones.filter(p => !classification.organizerPhones.includes(p)),
  ];

  const extractedFields = ['companyName', 'websiteUrl', 'domain'];
  if (dynamicLeadFields.contactName) extractedFields.push('contactName');
  if (dynamicLeadFields.contactTitle) extractedFields.push('contactTitle');
  if (validEmails.length > 0) extractedFields.push('email');
  if (validPhones.length > 0) extractedFields.push('phone');
  if (dynamicLeadFields.industry || webData.metaDescription) extractedFields.push('industry');
  if (dynamicLeadFields.city) extractedFields.push('city');
  if (dynamicLeadFields.address) extractedFields.push('address');

  const lead: ExtractedRawLead = {
    rowNumber: 1,
    rawText: (parsedText || webData.textContent).slice(0, 1500),
    rawData: {
      url: renderedFinalUrl,
      title: webData.title,
      metaDescription: webData.metaDescription,
      emails: validEmails,
      phones: validPhones,
      ...dynamicLeadFields,
    },
    companyName,
    domain,
    websiteUrl: dynamicLeadFields.websiteUrl || renderedFinalUrl,
    contactName: dynamicLeadFields.contactName || undefined,
    contactTitle: dynamicLeadFields.contactTitle || undefined,
    email: validEmails[0] || undefined,
    phone: validPhones[0] || undefined,
    city: dynamicLeadFields.city || undefined,
    state: dynamicLeadFields.state || undefined,
    country: dynamicLeadFields.country || undefined,
    address: dynamicLeadFields.address || undefined,
    industry: dynamicLeadFields.industry || webData.metaDescription?.slice(0, 100) || undefined,
    provenance: {
      sourceType: 'WEBSITE',
      sourceName: sourceName || webData.title || domain,
      url: renderedFinalUrl,
      extractedFields,
    },
  };

  return {
    status: 'COMPLETED',
    leads: [lead],
    rawRecords: [
      {
        rowNumber: 1,
        rawText: webData.textContent.slice(0, 3000),
        rawData: {
          url: webData.finalUrl,
          title: webData.title,
          emails: validEmails,
          phones: validPhones,
        },
        parseStatus: 'PARSED',
      },
    ],
    totalRecords: 1,
    pageType: classification.pageType,
  };
}
