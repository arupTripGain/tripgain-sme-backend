export function escapeCsvField(val: any): string {
  if (val === null || val === undefined) return '';
  let str = String(val);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    str = '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Standard CSV export for general Lead Intelligence records
 */
export function generateLeadsCsv(leads: any[]): string {
  const headers = [
    'ID',
    'Company Name',
    'Normalized Name',
    'Domain',
    'Website URL',
    'Contact Name',
    'Contact Title',
    'Email',
    'Phone',
    'City',
    'State',
    'Country',
    'Industry',
    'Company Size',
    'LinkedIn URL',
    'Source Type',
    'Source Name',
    'Dedupe Status',
    'Duplicate Reason',
    'Completeness Score',
    'Extracted At',
  ];

  const rows = leads.map(lead => [
    escapeCsvField(lead.id),
    escapeCsvField(lead.companyName),
    escapeCsvField(lead.companyNormalizedName),
    escapeCsvField(lead.domain),
    escapeCsvField(lead.websiteUrl),
    escapeCsvField(lead.contactName),
    escapeCsvField(lead.contactTitle),
    escapeCsvField(lead.email),
    escapeCsvField(lead.phone),
    escapeCsvField(lead.city),
    escapeCsvField(lead.state),
    escapeCsvField(lead.country),
    escapeCsvField(lead.industry),
    escapeCsvField(lead.companySize),
    escapeCsvField(lead.linkedinUrl),
    escapeCsvField(lead.sourceType),
    escapeCsvField(lead.sourceName),
    escapeCsvField(lead.dedupeStatus),
    escapeCsvField(lead.duplicateReason),
    escapeCsvField(lead.completenessScore !== undefined ? `${Math.round(lead.completenessScore * 100)}%` : ''),
    escapeCsvField(lead.extractedAt ? new Date(lead.extractedAt).toISOString() : ''),
  ]);

  return '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
}

/**
 * 38-column specification compliant CSV export for Research Batches
 */
export function generateBatchLeadsCsv(leads: any[], batchSourceUrl?: string | null): string {
  const headers = [
    'Company Name',
    'Normalized Company Name',
    'Contact Name',
    'First Name',
    'Last Name',
    'Job Title',
    'Email',
    'Phone',
    'Website',
    'Domain',
    'LinkedIn URL',
    'Country',
    'State',
    'City',
    'Address',
    'Industry',
    'Subindustry',
    'Category',
    'Product Category',
    'Employee Range',
    'Revenue Range',
    'Event Name',
    'Event Type',
    'Hall',
    'Booth',
    'Stall',
    'Source Type',
    'Source Name',
    'Source URL',
    'Listing URL',
    'Detail URL',
    'Source Page',
    'Source Row',
    'Duplicate Status',
    'Duplicate Reason',
    'Data Completeness',
    'Email Format Status',
    'Extracted At',
  ];

  const rows = leads.map(lead => {
    // Parse contact first / last name
    let firstName = '';
    let lastName = '';
    if (lead.contactName && typeof lead.contactName === 'string') {
      const parts = lead.contactName.trim().split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }

    // Inspect provenance rawData for extra exhibition attributes if available
    const prov = lead.provenance || {};
    const raw = prov.rawData || {};

    let subindustry = raw.subindustry || raw.subcategory || '';
    let category = raw.category || raw.sector || lead.industry || '';
    let productCategory = raw.productCategory || raw.productGroupName || raw.products || '';
    let employeeRange = lead.companySize || raw.employeeRange || raw.employees || '';
    let revenueRange = raw.revenueRange || raw.revenue || '';
    let eventName = raw.eventName || lead.sourceName || '';
    let eventType = raw.eventType || 'Trade Fair / Expo Directory';

    // Parse Hall / Booth / Stall from raw data or address
    let hall = raw.hall || raw.hallNumber || raw.hall_no || '';
    let booth = raw.booth || raw.boothNumber || '';
    let stall = raw.stall || raw.stallNumber || raw.stand || '';

    if (!hall && !booth && !stall && lead.address) {
      const mHall = lead.address.match(/hall\s*[:#]?\s*([a-zA-Z0-9\-_]+)/i);
      if (mHall) hall = mHall[1];
      const mBooth = lead.address.match(/(?:booth|stall|stand)\s*[:#]?\s*([a-zA-Z0-9\-_]+)/i);
      if (mBooth) booth = mBooth[1];
    }

    const sourceUrl = batchSourceUrl || prov.url || lead.websiteUrl || '';
    const listingUrl = prov.url || batchSourceUrl || '';
    const detailUrl = raw.detailUrl || (prov.url && prov.url !== batchSourceUrl ? prov.url : '');
    const sourcePage = prov.pageNumber || '';
    const sourceRow = prov.rowNumber || '';

    const emailFormatStatus = lead.hasValidEmail
      ? 'Valid Email Format'
      : (lead.email ? 'Invalid Format' : 'Missing');

    const dataCompleteness = lead.completenessScore !== undefined && lead.completenessScore !== null
      ? `${Math.round(lead.completenessScore * 100)}%`
      : '0%';

    return [
      escapeCsvField(lead.companyName),
      escapeCsvField(lead.companyNormalizedName),
      escapeCsvField(lead.contactName),
      escapeCsvField(firstName),
      escapeCsvField(lastName),
      escapeCsvField(lead.contactTitle),
      escapeCsvField(lead.email),
      escapeCsvField(lead.phone),
      escapeCsvField(lead.websiteUrl),
      escapeCsvField(lead.domain),
      escapeCsvField(lead.linkedinUrl),
      escapeCsvField(lead.country),
      escapeCsvField(lead.state),
      escapeCsvField(lead.city),
      escapeCsvField(lead.address),
      escapeCsvField(lead.industry),
      escapeCsvField(subindustry),
      escapeCsvField(category),
      escapeCsvField(productCategory),
      escapeCsvField(employeeRange),
      escapeCsvField(revenueRange),
      escapeCsvField(eventName),
      escapeCsvField(eventType),
      escapeCsvField(hall),
      escapeCsvField(booth),
      escapeCsvField(stall),
      escapeCsvField(lead.sourceType),
      escapeCsvField(lead.sourceName),
      escapeCsvField(sourceUrl),
      escapeCsvField(listingUrl),
      escapeCsvField(detailUrl),
      escapeCsvField(sourcePage),
      escapeCsvField(sourceRow),
      escapeCsvField(lead.dedupeStatus),
      escapeCsvField(lead.duplicateReason),
      escapeCsvField(dataCompleteness),
      escapeCsvField(emailFormatStatus),
      escapeCsvField(lead.extractedAt ? new Date(lead.extractedAt).toISOString() : ''),
    ];
  });

  return '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
}
