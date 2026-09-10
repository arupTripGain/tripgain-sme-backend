/**
 * Builds a canonical variable resolution context from a contact or enrollment record.
 * Guarantees identical variable resolution between Preview, Test Email, and Campaign Dispatch.
 * Zero mock company fallbacks.
 */
export interface CanonicalLeadContext {
  firstName: string;
  lastName: string;
  email: string;
  title: string;
  companyName: string;
  website: string;
  industry: string;
  companySize: string;
  companyPhone: string;
  personLinkedinUrl: string;
  city: string;
  personalization: string;
  personalizedLine: string;
  senderName: string;
  senderCompany: string;
  unsubscribeLink: string;
  [key: string]: string;
}

export function buildCanonicalLeadContext(
  lead: any,
  senderName: string = 'Arup Nirala',
  senderCompany: string = 'TripGain',
  unsubscribeLink: string = '#'
): CanonicalLeadContext {
  if (!lead) {
    return {
      firstName: '',
      lastName: '',
      email: '',
      title: '',
      companyName: '',
      website: '',
      industry: '',
      companySize: '',
      companyPhone: '',
      personLinkedinUrl: '',
      city: '',
      personalization: '',
      personalizedLine: '',
      senderName,
      senderCompany,
      unsubscribeLink
    };
  }

  const pers = (
    lead.personalizedLine ||
    lead.personalization ||
    lead.personalizationTrigger ||
    ''
  ).trim();

  const company = (
    lead.companyName ||
    lead.company ||
    lead.organization?.name ||
    ''
  ).trim();

  const email = (
    lead.email ||
    (Array.isArray(lead.emails) ? (lead.emails.find((e: any) => e?.isPrimary)?.email || lead.emails[0]?.email) : '') ||
    ''
  ).trim();

  return {
    firstName: (lead.firstName || '').trim(),
    lastName: (lead.lastName || '').trim(),
    email,
    title: (lead.jobTitle || lead.title || '').trim(),
    companyName: company,
    website: (lead.website || lead.organization?.domain || '').trim(),
    industry: (lead.industry || lead.organization?.industry || '').trim(),
    companySize: (lead.companySize || lead.organization?.employeeSize || '').trim(),
    companyPhone: (lead.companyPhone || lead.organization?.phone || '').trim(),
    personLinkedinUrl: (lead.personLinkedinUrl || lead.linkedinUrl || '').trim(),
    city: (lead.city || '').trim(),
    personalization: pers,
    personalizedLine: pers,
    senderName,
    senderCompany,
    unsubscribeLink
  };
}
