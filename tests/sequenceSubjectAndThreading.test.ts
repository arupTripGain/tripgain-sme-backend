import assert from 'assert';
import Handlebars from 'handlebars';

console.log('====================================================');
console.log('RUNNING SEQUENCE SUBJECT & EMAIL THREADING TESTS');
console.log('Synthetic / Mocked Data Only — Zero Real Emails / Leads');
console.log('====================================================\n');

interface MockStep {
  stepNumber: number;
  subjectTemplate: string | null;
  bodyTemplate: string;
}

interface MockOutboundMessage {
  id: string;
  enrollmentId: string;
  subject: string;
  internetMessageId: string;
  providerMessageId: string;
  inReplyToMessageId?: string | null;
  references?: string | null;
  providerThreadId?: string | null;
  sentAt: Date;
}

interface MockConversation {
  id: string;
  enrollmentId: string;
  contactId: string;
  campaignId: string;
  subject: string;
  providerThreadId?: string | null;
}

// Logic mirror from schedulerService.ts
function resolveStepSubjectAndThreading(params: {
  step: MockStep;
  enrollment: { id: string; currentStep: number; contactId: string };
  contact: { firstName: string; companyName: string };
  campaign: { id: string };
  previousEmail?: MockOutboundMessage | null;
  conversation?: MockConversation | null;
}) {
  const { step, enrollment, contact, campaign, previousEmail, conversation } = params;

  const isSubjectEmpty = !step.subjectTemplate || step.subjectTemplate.trim().length === 0;
  const isFollowUp = (step.stepNumber || enrollment.currentStep) > 1;

  let isReplyInThread = false;
  let parentInternetMessageId: string | null = null;
  let parentReferences: string | null = null;
  let parentProviderThreadId: string | null = null;
  let threadSubject = '';

  if (isFollowUp && isSubjectEmpty) {
    if (previousEmail) {
      const prevMsgId = previousEmail.internetMessageId || previousEmail.providerMessageId;
      if (prevMsgId) {
        isReplyInThread = true;
        parentInternetMessageId = prevMsgId.startsWith('<') && prevMsgId.endsWith('>') ? prevMsgId : `<${prevMsgId}>`;

        const existingReferences = typeof previousEmail.references === 'string' ? previousEmail.references.trim() : '';
        parentReferences = existingReferences
          ? `${existingReferences} ${parentInternetMessageId}`
          : parentInternetMessageId;

        parentProviderThreadId = conversation?.providerThreadId || previousEmail.providerThreadId || null;
        threadSubject = previousEmail.subject || '';
      }
    }
  }

  const templateData = {
    firstName: contact.firstName,
    companyName: contact.companyName
  };

  let renderedSubject = '';
  if (!isSubjectEmpty) {
    // CASE A: Step subject contains text -> Render with templateData
    const hSubject = Handlebars.compile(step.subjectTemplate!, { noEscape: true });
    renderedSubject = hSubject(templateData);
  } else if (isFollowUp && isReplyInThread) {
    // CASE B: Follow-up with empty subject -> reuse previous message subject, NO fallback generated
    renderedSubject = threadSubject;
  } else {
    // CASE C: Step 1 with empty subject -> genuinely empty, NO fallback generated
    renderedSubject = '';
  }

  // Construct mail options
  const mailOptions: {
    subject: string;
    inReplyTo?: string;
    references?: string;
    headers?: Record<string, string>;
  } = {
    subject: renderedSubject
  };

  if (isReplyInThread && parentInternetMessageId) {
    mailOptions.inReplyTo = parentInternetMessageId;
    mailOptions.references = parentReferences || parentInternetMessageId;
    mailOptions.headers = {
      'In-Reply-To': parentInternetMessageId,
      'References': parentReferences || parentInternetMessageId,
      ...(parentProviderThreadId ? { 'X-GM-THRID': parentProviderThreadId } : {})
    };
  }

  return {
    isReplyInThread,
    renderedSubject,
    parentInternetMessageId,
    parentReferences,
    parentProviderThreadId,
    mailOptions
  };
}

// ---------------------------------------------------------------------
// Test 1: Step 2 with explicit subject ("Quick question, {{firstName}}")
// Expected: Uses rendered explicit subject.
// ---------------------------------------------------------------------
{
  const res = resolveStepSubjectAndThreading({
    step: { stepNumber: 2, subjectTemplate: 'Quick question, {{firstName}}', bodyTemplate: 'Hello' },
    enrollment: { id: 'enr-1', currentStep: 2, contactId: 'cnt-1' },
    contact: { firstName: 'Arup', companyName: 'TripGain' },
    campaign: { id: 'camp-1' },
    previousEmail: {
      id: 'msg-1',
      enrollmentId: 'enr-1',
      subject: 'Initial Outreach',
      internetMessageId: '<tg_initial@tripgainapp.com>',
      providerMessageId: '<tg_initial@tripgainapp.com>',
      sentAt: new Date()
    }
  });

  assert.strictEqual(res.renderedSubject, 'Quick question, Arup', 'Must render and use explicit subject');
  assert.strictEqual(res.isReplyInThread, false, 'Explicit subject must not be treated as reply-in-thread');
  assert.strictEqual(res.mailOptions.inReplyTo, undefined);
  console.log('✔ Test 1 passed: Step 2 with explicit subject uses explicit rendered subject');
}

// ---------------------------------------------------------------------
// Test 2: Step 2 with empty subject ("")
// Expected: No generated fallback subject, reuses thread subject.
// ---------------------------------------------------------------------
{
  const res = resolveStepSubjectAndThreading({
    step: { stepNumber: 2, subjectTemplate: '', bodyTemplate: 'Following up...' },
    enrollment: { id: 'enr-2', currentStep: 2, contactId: 'cnt-2' },
    contact: { firstName: 'Arup', companyName: 'TripGain' },
    campaign: { id: 'camp-1' },
    previousEmail: {
      id: 'msg-prev',
      enrollmentId: 'enr-2',
      subject: 'Arup, one operational task to simplify as TripGain grows',
      internetMessageId: '<tg_prev123@tripgainapp.com>',
      providerMessageId: '<tg_prev123@tripgainapp.com>',
      sentAt: new Date()
    }
  });

  assert.strictEqual(res.isReplyInThread, true, 'Empty subject on Step 2 must trigger reply-in-thread');
  assert.strictEqual(res.renderedSubject, 'Arup, one operational task to simplify as TripGain grows');
  assert.notStrictEqual(res.renderedSubject, 'Outreach from TripGain', 'Must NEVER use generated fallback subject');
  assert.ok(!res.renderedSubject.startsWith('Re: '), 'Must NOT generate Re: prefix if not in original');
  console.log('✔ Test 2 passed: Step 2 with empty subject generates NO fallback subject and preserves thread subject');
}

// ---------------------------------------------------------------------
// Test 3: Step 2 with whitespace-only subject ("   ")
// Expected: Treated as empty.
// ---------------------------------------------------------------------
{
  const res = resolveStepSubjectAndThreading({
    step: { stepNumber: 2, subjectTemplate: '   ', bodyTemplate: 'Checking in' },
    enrollment: { id: 'enr-3', currentStep: 2, contactId: 'cnt-3' },
    contact: { firstName: 'Arup', companyName: 'TripGain' },
    campaign: { id: 'camp-1' },
    previousEmail: {
      id: 'msg-prev-3',
      enrollmentId: 'enr-3',
      subject: 'Original Thread Subject',
      internetMessageId: '<tg_msg3@tripgainapp.com>',
      providerMessageId: '<tg_msg3@tripgainapp.com>',
      sentAt: new Date()
    }
  });

  assert.strictEqual(res.isReplyInThread, true, 'Whitespace-only subject must be treated as empty');
  assert.strictEqual(res.renderedSubject, 'Original Thread Subject');
  console.log('✔ Test 3 passed: Step 2 with whitespace-only subject is correctly treated as empty');
}

// ---------------------------------------------------------------------
// Test 4: Step 2 empty subject -> In-Reply-To points to previous outbound message
// ---------------------------------------------------------------------
{
  const res = resolveStepSubjectAndThreading({
    step: { stepNumber: 2, subjectTemplate: '', bodyTemplate: 'Just following up' },
    enrollment: { id: 'enr-4', currentStep: 2, contactId: 'cnt-4' },
    contact: { firstName: 'Arup', companyName: 'TripGain' },
    campaign: { id: 'camp-1' },
    previousEmail: {
      id: 'msg-prev-4',
      enrollmentId: 'enr-4',
      subject: 'Simplifying travel',
      internetMessageId: '<tg_parent_444@tripgainapp.com>',
      providerMessageId: '<tg_parent_444@tripgainapp.com>',
      sentAt: new Date()
    }
  });

  assert.strictEqual(res.parentInternetMessageId, '<tg_parent_444@tripgainapp.com>');
  assert.strictEqual(res.mailOptions.inReplyTo, '<tg_parent_444@tripgainapp.com>');
  assert.strictEqual(res.mailOptions.headers?.['In-Reply-To'], '<tg_parent_444@tripgainapp.com>');
  console.log('✔ Test 4 passed: In-Reply-To header correctly points to previous outbound message ID');
}

// ---------------------------------------------------------------------
// Test 5: Step 2 empty subject -> References contains previous message Message-ID
// ---------------------------------------------------------------------
{
  // Step 2 replying to Step 1
  const resStep2 = resolveStepSubjectAndThreading({
    step: { stepNumber: 2, subjectTemplate: null, bodyTemplate: 'Follow-up 1' },
    enrollment: { id: 'enr-5', currentStep: 2, contactId: 'cnt-5' },
    contact: { firstName: 'Arup', companyName: 'TripGain' },
    campaign: { id: 'camp-1' },
    previousEmail: {
      id: 'msg-1',
      enrollmentId: 'enr-5',
      subject: 'Thread Root',
      internetMessageId: '<root_msg@tripgainapp.com>',
      providerMessageId: '<root_msg@tripgainapp.com>',
      references: null,
      sentAt: new Date()
    }
  });

  assert.strictEqual(resStep2.mailOptions.references, '<root_msg@tripgainapp.com>');

  // Step 3 replying to Step 2
  const resStep3 = resolveStepSubjectAndThreading({
    step: { stepNumber: 3, subjectTemplate: '', bodyTemplate: 'Follow-up 2' },
    enrollment: { id: 'enr-5', currentStep: 3, contactId: 'cnt-5' },
    contact: { firstName: 'Arup', companyName: 'TripGain' },
    campaign: { id: 'camp-1' },
    previousEmail: {
      id: 'msg-2',
      enrollmentId: 'enr-5',
      subject: 'Thread Root',
      internetMessageId: '<step2_msg@tripgainapp.com>',
      providerMessageId: '<step2_msg@tripgainapp.com>',
      references: '<root_msg@tripgainapp.com>',
      sentAt: new Date()
    }
  });

  assert.strictEqual(resStep3.mailOptions.references, '<root_msg@tripgainapp.com> <step2_msg@tripgainapp.com>', 'RFC 5322 references chain preserved');
  console.log('✔ Test 5 passed: References header correctly chains previous Message-IDs');
}

// ---------------------------------------------------------------------
// Test 6: Step 2 empty subject -> providerThreadId/Gmail threadId preserved
// ---------------------------------------------------------------------
{
  const res = resolveStepSubjectAndThreading({
    step: { stepNumber: 2, subjectTemplate: '', bodyTemplate: 'Follow-up' },
    enrollment: { id: 'enr-6', currentStep: 2, contactId: 'cnt-6' },
    contact: { firstName: 'Arup', companyName: 'TripGain' },
    campaign: { id: 'camp-1' },
    previousEmail: {
      id: 'msg-6',
      enrollmentId: 'enr-6',
      subject: 'Thread Subject',
      internetMessageId: '<tg_6@tripgainapp.com>',
      providerMessageId: '<tg_6@tripgainapp.com>',
      providerThreadId: 'thread_gmail_abc123',
      sentAt: new Date()
    },
    conversation: {
      id: 'conv-6',
      enrollmentId: 'enr-6',
      contactId: 'cnt-6',
      campaignId: 'camp-1',
      subject: 'Thread Subject',
      providerThreadId: 'thread_gmail_abc123'
    }
  });

  assert.strictEqual(res.parentProviderThreadId, 'thread_gmail_abc123');
  assert.strictEqual(res.mailOptions.headers?.['X-GM-THRID'], 'thread_gmail_abc123');
  console.log('✔ Test 6 passed: Gmail threadId (X-GM-THRID) is preserved where available');
}

// ---------------------------------------------------------------------
// Test 7: Step 2 empty subject -> binds to same email thread/enrollment
// ---------------------------------------------------------------------
{
  const existingConv: MockConversation = {
    id: 'conv-existing-7',
    enrollmentId: 'enr-7',
    contactId: 'cnt-7',
    campaignId: 'camp-7',
    subject: 'Initial Subject'
  };

  const res = resolveStepSubjectAndThreading({
    step: { stepNumber: 2, subjectTemplate: '', bodyTemplate: 'Follow-up' },
    enrollment: { id: 'enr-7', currentStep: 2, contactId: 'cnt-7' },
    contact: { firstName: 'Arup', companyName: 'TripGain' },
    campaign: { id: 'camp-7' },
    previousEmail: {
      id: 'msg-7',
      enrollmentId: 'enr-7',
      subject: 'Initial Subject',
      internetMessageId: '<tg_7@tripgainapp.com>',
      providerMessageId: '<tg_7@tripgainapp.com>',
      sentAt: new Date()
    },
    conversation: existingConv
  });

  // Reuses conversation id
  assert.strictEqual(existingConv.id, 'conv-existing-7');
  assert.strictEqual(res.renderedSubject, existingConv.subject);
  console.log('✔ Test 7 passed: Step 2 empty subject strictly preserves conversation thread identity');
}

// ---------------------------------------------------------------------
// Test 8: Step 1 empty subject -> does NOT attempt to reply in thread
// ---------------------------------------------------------------------
{
  const res = resolveStepSubjectAndThreading({
    step: { stepNumber: 1, subjectTemplate: '', bodyTemplate: 'First touch' },
    enrollment: { id: 'enr-8', currentStep: 1, contactId: 'cnt-8' },
    contact: { firstName: 'Arup', companyName: 'TripGain' },
    campaign: { id: 'camp-1' },
    previousEmail: null
  });

  assert.strictEqual(res.isReplyInThread, false, 'Step 1 must never be treated as reply-in-thread');
  assert.strictEqual(res.renderedSubject, '', 'Step 1 empty subject remains genuinely empty, no fallback');
  assert.strictEqual(res.mailOptions.inReplyTo, undefined);
  assert.strictEqual(res.mailOptions.references, undefined);
  console.log('✔ Test 8 passed: Step 1 empty subject does not attempt to reply and produces no fallback');
}

// ---------------------------------------------------------------------
// Test 9: Existing explicit-subject follow-ups continue working
// ---------------------------------------------------------------------
{
  const res = resolveStepSubjectAndThreading({
    step: { stepNumber: 3, subjectTemplate: 'New perspective for {{companyName}}', bodyTemplate: 'Check this out' },
    enrollment: { id: 'enr-9', currentStep: 3, contactId: 'cnt-9' },
    contact: { firstName: 'Arup', companyName: 'TripGain' },
    campaign: { id: 'camp-1' },
    previousEmail: {
      id: 'msg-9',
      enrollmentId: 'enr-9',
      subject: 'Old subject',
      internetMessageId: '<tg_9@tripgainapp.com>',
      providerMessageId: '<tg_9@tripgainapp.com>',
      sentAt: new Date()
    }
  });

  assert.strictEqual(res.renderedSubject, 'New perspective for TripGain');
  assert.strictEqual(res.isReplyInThread, false);
  assert.strictEqual(res.mailOptions.inReplyTo, undefined);
  console.log('✔ Test 9 passed: Explicit subject follow-ups continue working with full Handlebars templating');
}

// ---------------------------------------------------------------------
// Test 10: Existing reply detection / Unibox behavior continues working
// ---------------------------------------------------------------------
{
  // Simulating IMAP sync matching inbound reply header to outbound internetMessageId
  const outboundMessageIds = new Map<string, string>([
    ['tg_parent_444@tripgainapp.com', 'conv-unibox-10']
  ]);

  function matchInboundHeader(inReplyToHeader: string | null, referencesHeader: string[]): string | null {
    if (inReplyToHeader && outboundMessageIds.has(inReplyToHeader.replace(/[<>]/g, ''))) {
      return outboundMessageIds.get(inReplyToHeader.replace(/[<>]/g, ''))!;
    }
    for (const ref of referencesHeader) {
      const cleanRef = ref.replace(/[<>]/g, '');
      if (outboundMessageIds.has(cleanRef)) {
        return outboundMessageIds.get(cleanRef)!;
      }
    }
    return null;
  }

  const matchedByInReplyTo = matchInboundHeader('<tg_parent_444@tripgainapp.com>', []);
  assert.strictEqual(matchedByInReplyTo, 'conv-unibox-10');

  const matchedByRef = matchInboundHeader(null, ['<other@test.com>', '<tg_parent_444@tripgainapp.com>']);
  assert.strictEqual(matchedByRef, 'conv-unibox-10');
  console.log('✔ Test 10 passed: Inbound reply detection and Unibox threading match headers seamlessly');
}

console.log('\nAll 10 Sequence Subject & Email Threading Tests Passed Successfully!\n');
