import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// The existing simulate event
export const simulateEvent = async (req: Request, res: Response): Promise<void> => {
  try {
    const { enrollmentId, eventType } = req.body;
    
    const enrollment = await prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: { contact: true, campaign: true }
    });
    
    if (!enrollment) {
      res.status(404).json({ error: 'Enrollment not found' });
      return;
    }
    
    const now = new Date();
    let updateData: any = {
      stoppedAt: now,
      nextSendAt: null
    };

    let logMessage = '';

    switch (eventType) {
      case 'REPLY':
        updateData.status = 'replied';
        updateData.stopReason = 'REPLY_RECEIVED';
        logMessage = 'Contact replied to campaign email.';
        break;
      case 'UNSUBSCRIBE':
        updateData.status = 'unsubscribed';
        updateData.stopReason = 'UNSUBSCRIBED';
        logMessage = 'Contact unsubscribed from campaign.';
        break;
      case 'BOUNCE':
        updateData.status = 'bounced';
        updateData.stopReason = 'HARD_BOUNCE';
        logMessage = 'Email hard bounced.';
        break;
      case 'REGISTRATION':
        updateData.status = 'registered';
        updateData.stopReason = 'REGISTRATION_COMPLETED';
        logMessage = 'Contact completed TripGain registration.';
        await prisma.contact.update({
          where: { id: enrollment.contactId },
          data: { leadStatus: 'Registered' }
        });
        break;
      default:
        res.status(400).json({ error: 'Invalid event type' });
        return;
    }

    const updated = await prisma.enrollment.update({
      where: { id: enrollmentId },
      data: updateData
    });

    // Interconnected Campaign Records:
    const latestMsg = await prisma.emailMessage.findFirst({
      where: { enrollmentId },
      orderBy: { createdAt: 'desc' }
    });

    if (eventType === 'REPLY') {
      if (latestMsg) {
        await prisma.emailEvent.create({
          data: {
            emailMessageId: latestMsg.id,
            campaignId: enrollment.campaignId,
            enrollmentId: enrollment.id,
            contactId: enrollment.contactId,
            eventType: 'replied',
            eventAt: now
          }
        });
      }
      await prisma.auditLog.create({
        data: {
          campaignId: enrollment.campaignId,
          action: 'Contact Replied',
          details: `${enrollment.contact.firstName || 'Lead'} replied to campaign email. Further sequences paused.`,
          createdAt: now
        }
      }).catch(() => {});
    } else if (eventType === 'REGISTRATION') {
      await prisma.conversion.create({
        data: {
          campaignId: enrollment.campaignId,
          contactId: enrollment.contactId,
          conversionType: 'registered',
          conversionValue: 100,
          currency: 'INR',
          source: 'campaign_outreach',
          occurredAt: now
        }
      }).catch(() => {});
      await prisma.auditLog.create({
        data: {
          campaignId: enrollment.campaignId,
          action: 'Lead Converted',
          details: `${enrollment.contact.firstName || 'Lead'} registered on TripGain.`,
          createdAt: now
        }
      }).catch(() => {});
    } else if (eventType === 'BOUNCE' || eventType === 'UNSUBSCRIBE') {
      if (latestMsg) {
        await prisma.emailEvent.create({
          data: {
            emailMessageId: latestMsg.id,
            campaignId: enrollment.campaignId,
            enrollmentId: enrollment.id,
            contactId: enrollment.contactId,
            eventType: eventType.toLowerCase(),
            eventAt: now
          }
        }).catch(() => {});
      }
      await prisma.auditLog.create({
        data: {
          campaignId: enrollment.campaignId,
          action: eventType === 'BOUNCE' ? 'Email Bounced' : 'Contact Unsubscribed',
          details: logMessage,
          createdAt: now
        }
      }).catch(() => {});
    }

    await prisma.activityLog.create({
      data: {
        workspaceId: enrollment.campaign.workspaceId,
        action: `sequence_${updateData.status}`,
        description: logMessage,
        entityType: 'enrollment',
        entityId: enrollment.id,
        createdAt: now
      }
    });

    res.status(200).json({
      message: `Simulated ${eventType} event successfully`,
      enrollment: updated
    });

  } catch (error) {
    console.error('Error simulating event:', error);
    res.status(500).json({ error: 'Failed to simulate event' });
  }
};

// NEW Phase 9 Real Webhook Handler (e.g. from Resend)
export const handleProviderWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawBody = req.body; // In production we verify signatures here
    const providerEventId = rawBody.id; // Resend format
    const providerMessageId = rawBody.data?.email_id; 

    if (!providerEventId || !providerMessageId) {
       res.status(400).json({ error: 'Malformed payload' });
       return;
    }

    // 1. Deduplicate
    const existing = await prisma.emailEvent.findUnique({
      where: { providerEventId }
    });

    if (existing) {
       res.status(200).json({ ok: true, duplicate: true });
       return;
    }

    // 2. Find the message this belongs to
    const message = await prisma.emailMessage.findUnique({
      where: { providerMessageId },
      include: { 
        enrollment: {
          include: { campaign: true }
        }
      }
    });

    if (!message) {
      console.warn(`[Webhook] Message not found for provider ID: ${providerMessageId}`);
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    // Map provider types to our types
    const rawType = rawBody.type; // e.g. "email.bounced"
    let eventType = 'SENT';
    let messageUpdateData: any = { lastEventAt: new Date() };
    
    // Simple mock mapping
    if (rawType.includes('delivered')) {
      eventType = 'DELIVERED';
      messageUpdateData.deliveredAt = new Date();
      messageUpdateData.status = 'delivered';
    } else if (rawType.includes('opened')) {
      eventType = 'OPENED';
      messageUpdateData.openedAt = new Date();
    } else if (rawType.includes('clicked')) {
      eventType = 'CLICKED';
      messageUpdateData.clickedAt = new Date();
    } else if (rawType.includes('bounced')) {
      eventType = 'BOUNCED';
      messageUpdateData.bouncedAt = new Date();
      messageUpdateData.status = 'bounced';
    } else if (rawType.includes('complained')) {
      eventType = 'COMPLAINED';
      messageUpdateData.complainedAt = new Date();
      messageUpdateData.status = 'complained';
    } else if (rawType.includes('replied')) { // Faked for now
      eventType = 'REPLIED';
      messageUpdateData.repliedAt = new Date();
      messageUpdateData.status = 'replied';
    }

    // 3. Save Immutable Event
    await prisma.emailEvent.create({
      data: {
        provider: 'RESEND',
        providerEventId,
        providerMessageId,
        eventType,
        emailMessageId: message.id,
        contactId: message.contactId,
        campaignId: message.campaignId,
        enrollmentId: message.enrollmentId,
        rawPayload: rawBody,
        eventAt: rawBody.created_at ? new Date(rawBody.created_at) : new Date(),
        processed: true,
        processedAt: new Date()
      }
    });

    // 4. Update EmailMessage Status
    await prisma.emailMessage.update({
      where: { id: message.id },
      data: messageUpdateData
    });

    // 5. Hard Stops for Enrollments
    if (['BOUNCED', 'COMPLAINED', 'REPLIED'].includes(eventType) && message.enrollmentId) {
      await prisma.enrollment.update({
        where: { id: message.enrollmentId },
        data: {
          status: eventType.toLowerCase(),
          stopReason: eventType === 'REPLIED' ? 'REPLY_RECEIVED' : eventType,
          stoppedAt: new Date(),
          nextSendAt: null
        }
      });
      console.log(`[Webhook] Stopped Enrollment ${message.enrollmentId} due to ${eventType}`);
      
      // Stop all other active enrollments for this contact if bounced/complained
      if (['BOUNCED', 'COMPLAINED'].includes(eventType) && message.contactId) {
        await prisma.suppressionList.create({
          data: {
            email: message.toEmail,
            normalizedEmail: message.toEmail.toLowerCase(),
            reason: eventType,
            source: 'WEBHOOK'
          }
        });
      }

      // 6. Create Unibox Conversation if it's a REPLY (Phase 10)
      if (eventType === 'REPLIED' && message.contactId) {
        const contact = await prisma.contact.findUnique({ where: { id: message.contactId } });
        
        const conversation = await prisma.conversation.create({
          data: {
            contactId: message.contactId,
            organizationId: contact?.organizationId || null,
            campaignId: message.campaignId,
            enrollmentId: message.enrollmentId,
            subject: message.subject,
            status: 'NEEDS_ACTION',
            priority: 'HIGH',
            unreadCount: 1,
            replyRequired: true,
            latestMessageAt: new Date(),
            latestMessagePreview: "New incoming reply...",
            latestMessageDirection: 'INBOUND',
            lastInboundAt: new Date(),
            messages: {
              create: {
                direction: 'INBOUND',
                messageType: 'EMAIL',
                senderName: contact?.fullName || 'Prospect',
                senderEmail: message.toEmail, // the prospect's email
                subject: message.subject,
                bodyText: "New incoming reply text...",
                isRead: false,
                receivedAt: new Date()
              }
            }
          }
        });

        await prisma.activityLog.create({
          data: {
            workspaceId: message.enrollment?.campaign?.workspaceId || '',
            action: 'conversation_created',
            description: 'New reply received. Conversation moved to Unibox.',
            entityType: 'conversation',
            entityId: conversation.id
          }
        });
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
