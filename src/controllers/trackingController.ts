import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BOT_USER_AGENT_REGEX = /bot|crawler|spider|googleimageproxy|barracuda|proofpoint|mimecast|trendmicro|virustotal|curl|wget|python|facebookexternalhit|headless|semrush|ahrefs/i;

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const parts = forwarded.split(',');
    return parts[0]?.trim() || '';
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = forwarded[0];
    return first ? first.split(',')[0]?.trim() || '' : '';
  }
  return req.socket?.remoteAddress || '';
}

export const handleRedirect = async (req: Request, res: Response): Promise<void> => {
  const trackingToken = req.params.trackingToken as string;
  const fallbackUrl = process.env.DEFAULT_FALLBACK_URL || 'https://neo.tripgain.com/register-your-sme';
  let destinationUrl = fallbackUrl;

  // Extract client metadata for audit and scanner detection
  const ipAddress = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || '';
  const purpose = (req.headers['purpose'] || req.headers['x-purpose'] || req.headers['x-moz'] || '') as string;
  const isPrefetch = typeof purpose === 'string' && (purpose.toLowerCase().includes('prefetch') || purpose.toLowerCase().includes('preview'));
  const isBotUserAgent = BOT_USER_AGENT_REGEX.test(userAgent);
  const isBot = Boolean(isPrefetch || isBotUserAgent);

  try {
    if (!trackingToken) {
      res.redirect(302, destinationUrl);
      return;
    }

    // 1. First look up link in EmailLink table (Server-side stored destination - No open redirect!)
    const link = await prisma.emailLink.findUnique({
      where: { trackingToken },
      include: {
        message: {
          include: { campaign: true, enrollment: true }
        }
      }
    });

    if (link) {
      destinationUrl = link.destinationUrl;

      // Update link click counter
      await prisma.emailLink.update({
        where: { id: link.id },
        data: { clickCount: { increment: 1 } }
      });

      if (link.message) {
        const msg = link.message;

        // Record clicked state on EmailMessage without synthesizing a fake opened event
        await prisma.emailMessage.update({
          where: { id: msg.id },
          data: {
            clickedAt: msg.clickedAt || new Date(),
            lastEventAt: new Date(),
            status: msg.status === 'sent' || msg.status === 'delivered' ? 'clicked' : msg.status
          }
        });

        // Record the clicked event with rich metadata (IP, User-Agent, Bot detection)
        await prisma.emailEvent.create({
          data: {
            provider: 'INTERNAL',
            eventType: 'clicked',
            emailMessageId: msg.id,
            emailLinkId: link.id,
            contactId: msg.contactId,
            campaignId: msg.campaignId,
            enrollmentId: msg.enrollmentId,
            senderEmail: msg.fromEmail,
            recipientEmail: msg.toEmail,
            linkToken: link.trackingToken,
            linkUrl: link.destinationUrl,
            ipAddress,
            userAgent,
            metadata: {
              isBot,
              isPrefetch,
              linkText: link.linkText,
              linkType: link.linkType,
              userAgent,
              ipAddress
            },
            eventAt: new Date()
          }
        });
      }
    } else {
      // Fallback for legacy messages or manual url query (backwards-compatibility)
      const rawTargetUrl = req.query.url as string | undefined;
      const legacyMessage = await prisma.emailMessage.findFirst({
        where: {
          OR: [
            { trackingToken },
            { id: trackingToken }
          ]
        },
        include: { enrollment: true, campaign: true }
      });

      if (legacyMessage) {
        if (rawTargetUrl) {
          try {
            destinationUrl = decodeURIComponent(rawTargetUrl);
          } catch {
            destinationUrl = rawTargetUrl;
          }
        } else if (legacyMessage.campaign?.landingPageUrl) {
          destinationUrl = legacyMessage.campaign.landingPageUrl;
        }

        await prisma.emailMessage.update({
          where: { id: legacyMessage.id },
          data: {
            clickedAt: legacyMessage.clickedAt || new Date(),
            lastEventAt: new Date(),
            status: legacyMessage.status === 'sent' || legacyMessage.status === 'delivered' ? 'clicked' : legacyMessage.status,
            deliveryConfidence: 'ENGAGEMENT_CONFIRMED'
          }
        });

        await prisma.emailEvent.create({
          data: {
            provider: 'INTERNAL',
            eventType: 'clicked',
            emailMessageId: legacyMessage.id,
            contactId: legacyMessage.contactId,
            campaignId: legacyMessage.campaignId,
            enrollmentId: legacyMessage.enrollmentId,
            senderEmail: legacyMessage.fromEmail,
            recipientEmail: legacyMessage.toEmail,
            linkToken: trackingToken,
            linkUrl: destinationUrl,
            ipAddress,
            userAgent,
            metadata: { isBot, isPrefetch, userAgent, ipAddress },
            eventAt: new Date()
          }
        });
      } else {
        console.warn(`[Tracking] Unrecognized trackingToken "${trackingToken}", redirecting to fallback: ${fallbackUrl}`);
        destinationUrl = fallbackUrl;
      }
    }
  } catch (error) {
    console.error('[Tracking] Error handling click redirect:', error);
    destinationUrl = fallbackUrl;
  } finally {
    if (!destinationUrl.startsWith('http://') && !destinationUrl.startsWith('https://')) {
      destinationUrl = 'https://' + destinationUrl;
    }
    res.redirect(302, destinationUrl);
  }
};

export const handleOpenTracking = async (req: Request, res: Response): Promise<void> => {
  const trackingToken = req.params.trackingToken as string;

  const ipAddress = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || '';
  const isBot = BOT_USER_AGENT_REGEX.test(userAgent);

  const TRANSPARENT_1PX_GIF = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );

  try {
    if (trackingToken) {
      const message = await prisma.emailMessage.findFirst({
        where: {
          OR: [
            { trackingToken },
            { id: trackingToken }
          ]
        },
        include: { enrollment: true }
      });

      if (message) {
        await prisma.emailMessage.update({
          where: { id: message.id },
          data: {
            openedAt: message.openedAt || new Date(),
            lastEventAt: new Date(),
            status: message.status === 'sent' || message.status === 'delivered' ? 'opened' : message.status,
            deliveryConfidence: 'ENGAGEMENT_CONFIRMED'
          }
        });

        // Record the open event in EmailEvent
        await prisma.emailEvent.create({
          data: {
            provider: 'INTERNAL',
            eventType: 'opened',
            emailMessageId: message.id,
            contactId: message.contactId,
            campaignId: message.campaignId,
            enrollmentId: message.enrollmentId,
            senderEmail: message.fromEmail,
            recipientEmail: message.toEmail,
            ipAddress,
            userAgent,
            metadata: { isBot, userAgent, ipAddress },
            eventAt: new Date()
          }
        });
      }
    }
  } catch (error) {
    console.error('[Tracking] Error handling open tracking:', error);
  } finally {
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': TRANSPARENT_1PX_GIF.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(TRANSPARENT_1PX_GIF);
  }
};

export const handleUnsubscribe = async (req: Request, res: Response): Promise<void> => {
  const trackingToken = req.params.trackingToken as string;
  const ipAddress = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || '';

  try {
    if (!trackingToken) {
      res.status(400).send('Invalid unsubscribe link.');
      return;
    }

    const message = await prisma.emailMessage.findFirst({
      where: {
        OR: [
          { trackingToken },
          { id: trackingToken }
        ]
      },
      include: {
        campaign: true,
        contact: true,
        enrollment: true
      }
    });

    if (message) {
      const email = (message.toEmail || '').trim().toLowerCase();

      // 1. Mark Contact unsubscribed & doNotContact
      const targetContactId = message.contactId || message.enrollment?.contactId;
      if (targetContactId) {
        await prisma.contact.update({
          where: { id: targetContactId },
          data: {
            unsubscribeAt: new Date(),
            doNotContact: true
          }
        });
      } else if (email) {
        await prisma.contact.updateMany({
          where: {
            emails: { some: { normalizedEmail: email } }
          },
          data: {
            unsubscribeAt: new Date(),
            doNotContact: true
          }
        });
      }

      // 2. Add to SuppressionList (ensures future sends are blocked)
      if (email) {
        await prisma.suppressionList.upsert({
          where: { normalizedEmail: email },
          update: {
            reason: 'unsubscribe',
            suppressedAt: new Date()
          },
          create: {
            email: message.toEmail,
            normalizedEmail: email,
            reason: 'unsubscribe',
            userId: message.campaign?.userId || null,
            suppressedAt: new Date()
          }
        });
      }

      // 3. Stop any pending or active enrollments for this recipient
      if (targetContactId) {
        await prisma.enrollment.updateMany({
          where: {
            contactId: targetContactId,
            status: { in: ['pending', 'active', 'sending'] }
          },
          data: {
            status: 'unsubscribed',
            stoppedAt: new Date(),
            stopReason: 'UNSUBSCRIBED'
          }
        });
      } else if (message.enrollmentId) {
        await prisma.enrollment.update({
          where: { id: message.enrollmentId },
          data: {
            status: 'unsubscribed',
            stoppedAt: new Date(),
            stopReason: 'UNSUBSCRIBED'
          }
        });
      }

      // 4. Log EmailEvent
      await prisma.emailEvent.create({
        data: {
          provider: 'INTERNAL',
          eventType: 'unsubscribed',
          emailMessageId: message.id,
          contactId: message.contactId,
          campaignId: message.campaignId,
          enrollmentId: message.enrollmentId,
          senderEmail: message.fromEmail,
          recipientEmail: message.toEmail,
          ipAddress,
          userAgent,
          metadata: { ipAddress, userAgent },
          eventAt: new Date()
        }
      });

      // 5. Update EmailMessage
      await prisma.emailMessage.update({
        where: { id: message.id },
        data: {
          status: 'unsubscribed',
          complainedAt: new Date(),
          lastEventAt: new Date()
        }
      });
    }

    // Return clean branded confirmation page
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Successfully Unsubscribed | TripGain</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); max-width: 480px; width: 100%; text-align: center; border: 1px solid #e2e8f0; }
    .icon { width: 52px; height: 52px; background: #ecfdf5; color: #059669; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 26px; font-weight: bold; margin: 0 auto 20px auto; }
    h1 { font-size: 20px; font-weight: 700; margin: 0 0 8px 0; color: #0f172a; }
    p { font-size: 14px; color: #64748b; line-height: 1.6; margin: 0 0 24px 0; }
    .footer { font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10003;</div>
    <h1>Successfully Unsubscribed</h1>
    <p>You have been successfully unsubscribed. You will not receive marketing or outreach emails from this sender in the future.</p>
    <div class="footer">TripGain Outreach &bull; Deliverability &amp; Privacy Protected</div>
  </div>
</body>
</html>`);
  } catch (error) {
    console.error('[Tracking] Error handling unsubscribe:', error);
    res.status(500).send('An error occurred while processing your unsubscribe request.');
  }
};

