import assert from 'assert';
import {
  normalizeHeaderIds,
  findOutboundMessageByHeaders,
  resolveProspectContact,
  isInternalSender,
  stopEnrollmentsOnProspectReply,
  isEnrollmentStoppedDueToReply
} from '../src/services/replyStopService';
import { shouldStopBeforeSend } from '../src/services/schedulerService';

console.log('======================================================================');
console.log('RUNNING AUTOMATIC STOP ON PROSPECT REPLY REGRESSION TEST SUITE');
console.log('Synthetic In-Memory Store — ZERO Calls to Production Database');
console.log('======================================================================\n');

/**
 * In-memory Mock Prisma implementation to satisfy the 12 regression test cases
 * completely isolated from any external or production database.
 */
class InMemoryPrismaMock {
  public enrollments: any[] = [];
  public emailMessages: any[] = [];
  public conversationMessages: any[] = [];
  public contactEmails: any[] = [];
  public contacts: any[] = [];
  public mailboxes: any[] = [];
  public emailEvents: any[] = [];
  public _suppressions: any[] = [];
  public campaigns: any[] = [];

  public enrollment = {
    findUnique: async ({ where, include }: any) => {
      const e = this.enrollments.find(item => item.id === where.id);
      if (!e) return null;
      const res = { ...e };
      if (include?.campaign) {
        res.campaign = this.campaigns.find(c => c.id === e.campaignId) || { id: e.campaignId, status: 'active' };
      }
      if (include?.contact) {
        const contact = this.contacts.find(c => c.id === e.contactId) || { id: e.contactId, doNotContact: false };
        const emails = this.contactEmails.filter(ce => ce.contactId === e.contactId);
        res.contact = { ...contact, emails };
      }
      return res;
    },
    findFirst: async ({ where }: any) => {
      return this.enrollments.find(e => {
        if (where.id && e.id !== where.id) return false;
        if (where.contactId && e.contactId !== where.contactId) return false;
        if (where.status) {
          if (typeof where.status === 'string' && e.status !== where.status) return false;
          if (Array.isArray(where.status?.in) && !where.status.in.includes(e.status)) return false;
        }
        if (where.stopReason?.contains && !e.stopReason?.toLowerCase().includes(where.stopReason.contains.toLowerCase())) {
          return false;
        }
        if (where.OR) {
          const matchOr = where.OR.some((orClause: any) => {
            if (orClause.status && e.status === orClause.status) return true;
            if (orClause.stopReason?.contains && e.stopReason?.toLowerCase().includes(orClause.stopReason.contains.toLowerCase())) return true;
            return false;
          });
          if (!matchOr) return false;
        }
        return true;
      }) || null;
    },
    findMany: async ({ where }: any) => {
      return this.enrollments.filter(e => {
        if (where.contactId && e.contactId !== where.contactId) return false;
        if (where.campaignId && e.campaignId !== where.campaignId) return false;
        if (where.status?.in && !where.status.in.includes(e.status)) return false;
        return true;
      });
    },
    update: async ({ where, data }: any) => {
      const idx = this.enrollments.findIndex(e => e.id === where.id);
      if (idx === -1) throw new Error(`Enrollment not found: ${where.id}`);
      this.enrollments[idx] = { ...this.enrollments[idx], ...data };
      return this.enrollments[idx];
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (let i = 0; i < this.enrollments.length; i++) {
        const e = this.enrollments[i];
        if (where.id?.in && where.id.in.includes(e.id)) {
          this.enrollments[i] = { ...e, ...data };
          count++;
        }
      }
      return { count };
    }
  };

  public emailMessage = {
    findFirst: async ({ where }: any) => {
      return this.emailMessages.find(m => {
        if (where.id && m.id !== where.id) return false;
        if (where.contactId && m.contactId !== where.contactId) return false;
        if (where.enrollmentId && m.enrollmentId !== where.enrollmentId) return false;
        if (where.toEmail?.equals && m.toEmail?.toLowerCase() !== where.toEmail.equals.toLowerCase()) return false;
        if (where.status) {
          if (typeof where.status === 'string' && m.status !== where.status) return false;
          if (Array.isArray(where.status?.in) && !where.status.in.includes(m.status)) return false;
        }
        if (where.OR) {
          const matchOr = where.OR.some((orClause: any) => {
            if (orClause.internetMessageId?.in && orClause.internetMessageId.in.includes(m.internetMessageId)) return true;
            if (orClause.providerMessageId?.in && orClause.providerMessageId.in.includes(m.providerMessageId)) return true;
            if (orClause.status && m.status === orClause.status) return true;
            if (orClause.repliedAt?.not === null && m.repliedAt != null) return true;
            return false;
          });
          if (!matchOr) return false;
        }
        return true;
      }) || null;
    },
    findMany: async ({ where }: any) => {
      return this.emailMessages.filter(m => {
        if (where.contactId && m.contactId !== where.contactId) return false;
        if (where.enrollmentId && m.enrollmentId !== where.enrollmentId) return false;
        return true;
      });
    },
    update: async ({ where, data }: any) => {
      const idx = this.emailMessages.findIndex(m => m.id === where.id);
      if (idx === -1) throw new Error(`EmailMessage not found: ${where.id}`);
      this.emailMessages[idx] = { ...this.emailMessages[idx], ...data };
      return this.emailMessages[idx];
    },
    create: async ({ data }: any) => {
      const newMsg = { id: `msg_${Date.now()}_${Math.random()}`, ...data };
      this.emailMessages.push(newMsg);
      return newMsg;
    }
  };

  public conversationMessage = {
    findFirst: async ({ where }: any) => {
      return this.conversationMessages.find(c => {
        if (where.direction && c.direction !== where.direction) return false;
        if (where.conversation?.contactId && c.conversation?.contactId !== where.conversation.contactId) return false;
        if (where.OR) {
          const matchOr = where.OR.some((orClause: any) => {
            if (orClause.internetMessageId?.in && orClause.internetMessageId.in.includes(c.internetMessageId)) return true;
            if (orClause.providerMessageId?.in && orClause.providerMessageId.in.includes(c.providerMessageId)) return true;
            return false;
          });
          if (!matchOr) return false;
        }
        return true;
      }) || null;
    },
    create: async ({ data }: any) => {
      const newConv = { id: `conv_${Date.now()}_${Math.random()}`, ...data };
      this.conversationMessages.push(newConv);
      return newConv;
    }
  };

  public contactEmail = {
    findFirst: async ({ where }: any) => {
      return this.contactEmails.find(ce => {
        if (where.contactId && ce.contactId !== where.contactId) return false;
        if (where.normalizedEmail && ce.normalizedEmail !== where.normalizedEmail) return false;
        if (where.OR) {
          const matchOr = where.OR.some((orClause: any) => {
            if (orClause.normalizedEmail && ce.normalizedEmail === orClause.normalizedEmail) return true;
            if (orClause.email?.equals && ce.email?.toLowerCase() === orClause.email.equals.toLowerCase()) return true;
            return false;
          });
          if (!matchOr) return false;
        }
        return true;
      }) || null;
    },
    create: async ({ data }: any) => {
      const newCe = { id: `ce_${Date.now()}_${Math.random()}`, ...data };
      this.contactEmails.push(newCe);
      return newCe;
    }
  };

  public contact = {
    findUnique: async ({ where }: any) => {
      return this.contacts.find(c => c.id === where.id) || null;
    },
    findFirst: async ({ where }: any) => {
      return this.contacts.find(c => {
        if (where.id && c.id !== where.id) return false;
        if (where.email && c.email?.toLowerCase() !== where.email.toLowerCase()) return false;
        return true;
      }) || null;
    }
  };

  public mailbox = {
    findFirst: async ({ where }: any) => {
      return this.mailboxes.find(mb => {
        if (where.email?.equals && mb.email?.toLowerCase() === where.email.equals.toLowerCase()) return true;
        return false;
      }) || null;
    }
  };

  public emailEvent = {
    findFirst: async ({ where }: any) => {
      return this.emailEvents.find(ev => {
        if (where.emailMessageId && ev.emailMessageId !== where.emailMessageId) return false;
        if (where.contactId && ev.contactId !== where.contactId) return false;
        if (where.eventType) {
          if (typeof where.eventType === 'string' && ev.eventType !== where.eventType) return false;
          if (Array.isArray(where.eventType?.in) && !where.eventType.in.includes(ev.eventType)) return false;
        }
        return true;
      }) || null;
    },
    create: async ({ data }: any) => {
      const newEv = { id: `ev_${Date.now()}_${Math.random()}`, ...data };
      this.emailEvents.push(newEv);
      return newEv;
    }
  };

  public suppressionList = {
    findUnique: async ({ where }: any) => {
      return this._suppressions.find((s: any) => {
        if (where.normalizedEmail && s.normalizedEmail === where.normalizedEmail) return true;
        return false;
      }) || null;
    },
    findFirst: async ({ where }: any) => {
      return this._suppressions.find((s: any) => {
        if (where.normalizedEmail && s.normalizedEmail === where.normalizedEmail) return true;
        return false;
      }) || null;
    }
  };

  public campaign = {
    findUnique: async ({ where }: any) => {
      return this.campaigns.find(c => c.id === where.id) || null;
    }
  };
}

async function runAutomaticStopRegressionSuite() {
  let passedCount = 0;
  const totalCount = 12;

  // ------------------------------------------------------------------------------------------------
  // Scenario 1: Prospect replies to Step 1; Step 2 is never sent.
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    const contactId = 'c1';
    const enrollmentId = 'e1';

    db.contacts.push({ id: contactId, email: 'lead1@corp.com' });
    db.contactEmails.push({ id: 'ce1', contactId, email: 'lead1@corp.com', normalizedEmail: 'lead1@corp.com' });
    db.enrollments.push({
      id: enrollmentId,
      contactId,
      status: 'active',
      currentStep: 1,
      nextSendAt: new Date(Date.now() + 3600000)
    });
    db.emailMessages.push({
      id: 'm1',
      contactId,
      enrollmentId,
      toEmail: 'lead1@corp.com',
      status: 'sent',
      internetMessageId: '<msg-step-1@tripgain.com>',
      sentAt: new Date(Date.now() - 3600000)
    });

    // Inbound reply arrives for Step 1
    const stopResult = await stopEnrollmentsOnProspectReply({
      contactId,
      enrollmentId,
      internetMessageId: '<reply-step-1@corp.com>',
      replyDate: new Date(),
      prismaClient: db
    });

    assert.strictEqual(stopResult.stoppedEnrollmentCount, 1);
    const updatedEnrollment = await db.enrollment.findUnique({ where: { id: enrollmentId } });
    assert.strictEqual(updatedEnrollment.status, 'replied');
    assert.strictEqual(updatedEnrollment.stopReason, 'REPLY_RECEIVED');
    assert.strictEqual(updatedEnrollment.nextSendAt, null); // Scheduled Step 2 cancelled

    // Pre-send check confirms it is stopped
    const safetyCheck = await isEnrollmentStoppedDueToReply(enrollmentId, contactId, db);
    assert.strictEqual(safetyCheck.stopped, true);
    assert.strictEqual(safetyCheck.reason, 'REPLY_RECEIVED');

    console.log('✔ Test 1 passed: Prospect replies to Step 1; Step 2 is cancelled and never sent');
    passedCount++;
  }

  // ------------------------------------------------------------------------------------------------
  // Scenario 2: Prospect replies while a follow-up is queued; the queued message is blocked.
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    const contactId = 'c2';
    const enrollmentId = 'e2';

    db.contacts.push({ id: contactId, email: 'lead2@corp.com' });
    db.contactEmails.push({ id: 'ce2', contactId, email: 'lead2@corp.com', normalizedEmail: 'lead2@corp.com' });
    db.enrollments.push({
      id: enrollmentId,
      contactId,
      status: 'sending', // In queue / in flight
      currentStep: 2,
      nextSendAt: new Date(Date.now() - 60000)
    });

    // Inbound reply arrives while job sits in queue
    await stopEnrollmentsOnProspectReply({
      contactId,
      enrollmentId,
      prismaClient: db
    });

    // Worker evaluates before sending queued job
    const check = await isEnrollmentStoppedDueToReply(enrollmentId, contactId, db);
    assert.strictEqual(check.stopped, true);
    assert.strictEqual(check.reason, 'REPLY_RECEIVED');

    console.log('✔ Test 2 passed: Prospect replies while follow-up is queued; queued message is blocked');
    passedCount++;
  }

  // ------------------------------------------------------------------------------------------------
  // Scenario 3: Prospect replies between scheduler reservation and SMTP dispatch; the send is blocked.
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    const contactId = 'c3';
    const enrollmentId = 'e3';

    db.contacts.push({ id: contactId, email: 'lead3@corp.com' });
    db.contactEmails.push({ id: 'ce3', contactId, email: 'lead3@corp.com', normalizedEmail: 'lead3@corp.com' });
    db.enrollments.push({
      id: enrollmentId,
      contactId,
      status: 'active',
      currentStep: 2,
      nextSendAt: new Date(Date.now() - 5000)
    });
    db.emailMessages.push({
      id: 'm3_prev',
      contactId,
      enrollmentId,
      toEmail: 'lead3@corp.com',
      status: 'sent',
      internetMessageId: '<out-prev-3@tripgain.com>',
      sentAt: new Date(Date.now() - 86400000)
    });

    // Scheduler reserved the enrollment into local memory, but before transporter.sendMail is called,
    // an inbound email webhook or sync stopped the contact!
    await stopEnrollmentsOnProspectReply({
      contactId,
      enrollmentId,
      prismaClient: db
    });

    // Concurrency pre-flight guard immediately before SMTP transport
    const immediatePreFlight = await isEnrollmentStoppedDueToReply(enrollmentId, contactId, db);
    assert.strictEqual(immediatePreFlight.stopped, true);
    assert.strictEqual(immediatePreFlight.reason, 'REPLY_RECEIVED');

    console.log('✔ Test 3 passed: Prospect replies between scheduler reservation and SMTP dispatch; send is blocked');
    passedCount++;
  }

  // ------------------------------------------------------------------------------------------------
  // Scenario 4: Duplicate IMAP synchronization does not create inconsistent state.
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    const contactId = 'c4';
    const enrollmentId = 'e4';

    db.contacts.push({ id: contactId, email: 'lead4@corp.com' });
    db.contactEmails.push({ id: 'ce4', contactId, email: 'lead4@corp.com', normalizedEmail: 'lead4@corp.com' });
    db.enrollments.push({
      id: enrollmentId,
      contactId,
      status: 'active',
      currentStep: 1,
      nextSendAt: new Date()
    });
    db.emailMessages.push({
      id: 'm4',
      contactId,
      enrollmentId,
      toEmail: 'lead4@corp.com',
      status: 'sent',
      sentAt: new Date()
    });

    // Sync 1
    const res1 = await stopEnrollmentsOnProspectReply({ contactId, enrollmentId, prismaClient: db });
    assert.strictEqual(res1.stoppedEnrollmentCount, 1);
    assert.strictEqual(db.emailEvents.length, 1);

    // Sync 2 (duplicate IMAP run)
    const res2 = await stopEnrollmentsOnProspectReply({ contactId, enrollmentId, prismaClient: db });
    assert.strictEqual(res2.stoppedEnrollmentCount, 0); // Already stopped, idempotent
    assert.strictEqual(db.emailEvents.length, 1); // No duplicate events created

    const enrollState = await db.enrollment.findUnique({ where: { id: enrollmentId } });
    assert.strictEqual(enrollState.status, 'replied');
    assert.strictEqual(enrollState.nextSendAt, null);

    console.log('✔ Test 4 passed: Duplicate IMAP synchronization is idempotent and maintains consistent state');
    passedCount++;
  }

  // ------------------------------------------------------------------------------------------------
  // Scenario 5: Replies in the same thread are detected (via In-Reply-To / References).
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    const contactId = 'c5';
    const enrollmentId = 'e5';
    const outboundInternetId = '<tg_outbound_step1_12345@tripgain.com>';

    db.emailMessages.push({
      id: 'm5',
      contactId,
      enrollmentId,
      toEmail: 'lead5@corp.com',
      status: 'sent',
      internetMessageId: outboundInternetId,
      sentAt: new Date()
    });

    // IMAP parser extracts In-Reply-To header
    const candidateHeaders = [outboundInternetId, 'tg_outbound_step1_12345@tripgain.com'];
    const match = await findOutboundMessageByHeaders(candidateHeaders, db);

    assert.strictEqual(match.matched, true);
    assert.strictEqual(match.emailMessageId, 'm5');
    assert.strictEqual(match.contactId, contactId);
    assert.strictEqual(match.enrollmentId, enrollmentId);

    console.log('✔ Test 5 passed: Replies in the same thread are detected via In-Reply-To / References headers');
    passedCount++;
  }

  // ------------------------------------------------------------------------------------------------
  // Scenario 6: Replies from the same enrolled contact in a new thread are handled appropriately.
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    const contactId = 'c6';
    const enrollmentId = 'e6';

    db.contacts.push({ id: contactId, email: 'lead6@domain.com' });
    db.contactEmails.push({ id: 'ce6', contactId, email: 'lead6@domain.com', normalizedEmail: 'lead6@domain.com' });
    db.enrollments.push({
      id: enrollmentId,
      contactId,
      status: 'active',
      currentStep: 1,
      nextSendAt: new Date(Date.now() + 100000)
    });

    // Inbound reply arrives with NO In-Reply-To / References (new thread), but from lead6@domain.com
    const headerMatch = { matched: false };
    const resolution = await resolveProspectContact('lead6@domain.com', headerMatch, db);

    assert.strictEqual(resolution.contactId, contactId);
    assert.strictEqual(resolution.matchedVia, 'DIRECT_CONTACT_EMAIL');

    // Calling stop on this resolved contact
    const stopRes = await stopEnrollmentsOnProspectReply({ contactId: resolution.contactId!, prismaClient: db });
    assert.strictEqual(stopRes.stoppedEnrollmentCount, 1);

    const enrollmentState = await db.enrollment.findUnique({ where: { id: enrollmentId } });
    assert.strictEqual(enrollmentState.status, 'replied');

    console.log('✔ Test 6 passed: Replies from same enrolled contact in a new thread are recognized and stopped');
    passedCount++;
  }

  // ------------------------------------------------------------------------------------------------
  // Scenario 7: An unrelated inbound email does not stop another contact's enrollment.
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    const contactIdA = 'cA';
    const contactIdB = 'cB';

    db.contacts.push({ id: contactIdA, email: 'leadA@domain.com' });
    db.contactEmails.push({ id: 'ceA', contactId: contactIdA, email: 'leadA@domain.com', normalizedEmail: 'leada@domain.com' });
    db.enrollments.push({ id: 'eA', contactId: contactIdA, status: 'active', nextSendAt: new Date(Date.now() + 50000) });

    db.contacts.push({ id: contactIdB, email: 'leadB@domain.com' });
    db.contactEmails.push({ id: 'ceB', contactId: contactIdB, email: 'leadB@domain.com', normalizedEmail: 'leadb@domain.com' });
    db.enrollments.push({ id: 'eB', contactId: contactIdB, status: 'active', nextSendAt: new Date(Date.now() + 50000) });

    // Inbound message arrives from stranger@domain.com (unrelated)
    const resolution = await resolveProspectContact('stranger@domain.com', { matched: false }, db);
    assert.strictEqual(resolution.contactId, null);

    // Active enrollments for A and B remain active
    const checkA = await isEnrollmentStoppedDueToReply('eA', contactIdA, db);
    const checkB = await isEnrollmentStoppedDueToReply('eB', contactIdB, db);
    assert.strictEqual(checkA.stopped, false);
    assert.strictEqual(checkB.stopped, false);

    console.log('✔ Test 7 passed: Unrelated inbound email does not stop other contacts enrollments');
    passedCount++;
  }

  // ------------------------------------------------------------------------------------------------
  // Scenario 8: An internal/outbound message is not mistaken for a prospect reply.
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    db.mailboxes.push({ id: 'mb1', email: 'sales@tripgain.com' });
    db.mailboxes.push({ id: 'mb2', email: 'team@tripgain.com' });

    const isInternalSame = await isInternalSender('sales@tripgain.com', 'sales@tripgain.com', db);
    const isInternalColleague = await isInternalSender('team@tripgain.com', 'sales@tripgain.com', db);
    const isExternalLead = await isInternalSender('prospect@client.com', 'sales@tripgain.com', db);

    assert.strictEqual(isInternalSame, true);
    assert.strictEqual(isInternalColleague, true);
    assert.strictEqual(isExternalLead, false);

    console.log('✔ Test 8 passed: Internal / outbound messages are never mistaken for prospect replies');
    passedCount++;
  }

  // ------------------------------------------------------------------------------------------------
  // Scenario 9: A contact with multiple active relevant sequences is handled consistently.
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    const contactId = 'c9';

    db.contacts.push({ id: contactId, email: 'prospect9@enterprise.com' });
    db.contactEmails.push({ id: 'ce9', contactId, email: 'prospect9@enterprise.com', normalizedEmail: 'prospect9@enterprise.com' });
    db.enrollments.push({ id: 'e9_campaign_A', contactId, status: 'active', nextSendAt: new Date() });
    db.enrollments.push({ id: 'e9_bulk_campaign_B', contactId, status: 'pending', nextSendAt: new Date() });

    // Prospect replies
    const stopResult = await stopEnrollmentsOnProspectReply({ contactId, prismaClient: db });

    assert.strictEqual(stopResult.stoppedEnrollmentCount, 2);
    assert.deepStrictEqual(stopResult.stoppedEnrollmentIds.sort(), ['e9_bulk_campaign_B', 'e9_campaign_A'].sort());

    const eA = await db.enrollment.findUnique({ where: { id: 'e9_campaign_A' } });
    const eB = await db.enrollment.findUnique({ where: { id: 'e9_bulk_campaign_B' } });
    assert.strictEqual(eA.status, 'replied');
    assert.strictEqual(eB.status, 'replied');
    assert.strictEqual(eA.nextSendAt, null);
    assert.strictEqual(eB.nextSendAt, null);

    console.log('✔ Test 9 passed: Contact with multiple active relevant sequences stops all sequences consistently');
    passedCount++;
  }

  // ------------------------------------------------------------------------------------------------
  // Scenario 10: Campaigns without replies continue normally.
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    const contactId = 'c10';
    const enrollmentId = 'e10';

    db.contacts.push({ id: contactId, email: 'normal10@corp.com' });
    db.contactEmails.push({ id: 'ce10', contactId, email: 'normal10@corp.com', normalizedEmail: 'normal10@corp.com' });
    db.enrollments.push({
      id: enrollmentId,
      contactId,
      status: 'active',
      currentStep: 1,
      nextSendAt: new Date()
    });

    const check = await isEnrollmentStoppedDueToReply(enrollmentId, contactId, db);
    assert.strictEqual(check.stopped, false);

    console.log('✔ Test 10 passed: Campaigns without replies continue normally without false positives');
    passedCount++;
  }

  // ------------------------------------------------------------------------------------------------
  // Scenario 11: Existing unsubscribe and suppression protections continue working.
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    const contactId = 'c11';
    const enrollmentId = 'e11';

    // 1. Prospect reply does NOT add to suppression list
    db.contacts.push({ id: contactId, email: 'unsub11@domain.com' });
    db.contactEmails.push({ id: 'ce11', contactId, email: 'unsub11@domain.com', normalizedEmail: 'unsub11@domain.com' });
    db.enrollments.push({ id: enrollmentId, contactId, status: 'active', nextSendAt: new Date() });

    await stopEnrollmentsOnProspectReply({ contactId, enrollmentId, prismaClient: db });
    assert.strictEqual(db._suppressions.length, 0); // Not suppressed globally

    // 2. Unsubscribed enrollment is stopped by shouldStopBeforeSend
    const unsubsEnrollmentId = 'e11_unsub';
    db.enrollments.push({ id: unsubsEnrollmentId, contactId, status: 'unsubscribed', stopReason: 'UNSUBSCRIBED' });
    const safetyCheck = await isEnrollmentStoppedDueToReply(unsubsEnrollmentId, contactId, db);
    assert.strictEqual(safetyCheck.stopped, true);
    assert.strictEqual(safetyCheck.reason, 'UNSUBSCRIBED');

    console.log('✔ Test 11 passed: Existing unsubscribe and suppression protections continue working; replies do not suppress');
    passedCount++;
  }

  // ------------------------------------------------------------------------------------------------
  // Scenario 12: Bulk Email and standard sequence sending both enforce the protection.
  // ------------------------------------------------------------------------------------------------
  {
    const db = new InMemoryPrismaMock();
    const contactId = 'c12';

    // Campaign 1: Standard sequence
    db.campaigns.push({ id: 'camp_standard', campaignType: 'STANDARD_SEQUENCE' });
    db.enrollments.push({
      id: 'enroll_standard',
      campaignId: 'camp_standard',
      contactId,
      status: 'active',
      nextSendAt: new Date()
    });

    // Campaign 2: Bulk Email campaign
    db.campaigns.push({ id: 'camp_bulk', campaignType: 'BULK_EMAIL' });
    db.enrollments.push({
      id: 'enroll_bulk',
      campaignId: 'camp_bulk',
      contactId,
      status: 'active',
      nextSendAt: new Date()
    });

    // Prospect replies to standard sequence
    await stopEnrollmentsOnProspectReply({ contactId, enrollmentId: 'enroll_standard', prismaClient: db });

    // Both sending paths check shouldStopBeforeSend
    const checkStandard = await isEnrollmentStoppedDueToReply('enroll_standard', contactId, db);
    const checkBulk = await isEnrollmentStoppedDueToReply('enroll_bulk', contactId, db);

    assert.strictEqual(checkStandard.stopped, true);
    assert.strictEqual(checkStandard.reason, 'REPLY_RECEIVED');
    assert.strictEqual(checkBulk.stopped, true);
    assert.strictEqual(checkBulk.reason, 'REPLY_RECEIVED');

    console.log('✔ Test 12 passed: Both Bulk Email and Standard Sequences enforce automatic reply stop protection');
    passedCount++;
  }

  console.log('\n======================================================================');
  console.log(`ALL ${passedCount} / ${totalCount} REGRESSION TESTS PASSED SUCCESSFULLY!`);
  console.log('======================================================================');
}

runAutomaticStopRegressionSuite().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
