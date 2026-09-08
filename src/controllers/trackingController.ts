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
            status: legacyMessage.status === 'sent' || legacyMessage.status === 'delivered' ? 'clicked' : legacyMessage.status
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
            status: message.status === 'sent' || message.status === 'delivered' ? 'opened' : message.status
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
