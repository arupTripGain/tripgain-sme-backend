import { Request, Response } from 'express';
import { PrismaClient, Campaign, Contact, List, Mailbox, Conversation } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { AuthUser, JWT_SECRET } from '../middleware/authMiddleware';

const prisma = new PrismaClient();

export class OwnershipGuard {
  static getAuthUser(req: Request): AuthUser | null {
    if (req.user && req.user.userId) return req.user;
    const authHeader = req.headers ? (req.headers['authorization'] as string) : undefined;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
        req.user = decoded;
        return decoded;
      } catch {
        return null;
      }
    }
    return null;
  }

  static requireUser(req: Request, res: Response): AuthUser | null {
    if (req.user && req.user.userId) {
      return req.user;
    }

    const authHeader = req.headers ? (req.headers['authorization'] as string) : undefined;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (!token) {
      res.status(401).json({ error: 'Unauthorized: Access token is missing' });
      return null;
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
      req.user = decoded;
      return decoded;
    } catch (err) {
      res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
      return null;
    }
  }

  static async assertCampaign(req: Request, res: Response, campaignId: string): Promise<Campaign | null> {
    const user = this.requireUser(req, res);
    if (!user) return null;

    const campaign = await prisma.campaign.findFirst({
      where: {
        id: campaignId,
        userId: user.userId
      }
    });

    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return null;
    }

    return campaign;
  }

  static async assertContact(req: Request, res: Response, contactId: string): Promise<Contact | null> {
    const user = this.requireUser(req, res);
    if (!user) return null;

    const contact = await prisma.contact.findFirst({
      where: {
        id: contactId,
        userId: user.userId
      }
    });

    if (!contact) {
      res.status(404).json({ error: 'Contact not found' });
      return null;
    }

    return contact;
  }

  static async assertList(req: Request, res: Response, listId: string): Promise<List | null> {
    const user = this.requireUser(req, res);
    if (!user) return null;

    const list = await prisma.list.findFirst({
      where: {
        id: listId,
        userId: user.userId
      }
    });

    if (!list) {
      res.status(404).json({ error: 'List not found' });
      return null;
    }

    return list;
  }

  static async assertMailbox(req: Request, res: Response, mailboxId: string): Promise<Mailbox | null> {
    const user = this.requireUser(req, res);
    if (!user) return null;

    const mailbox = await prisma.mailbox.findFirst({
      where: {
        id: mailboxId,
        userId: user.userId
      }
    });

    if (!mailbox) {
      res.status(404).json({ error: 'Mailbox not found' });
      return null;
    }

    return mailbox;
  }

  static async assertConversation(req: Request, res: Response, conversationId: string): Promise<Conversation | null> {
    const user = this.requireUser(req, res);
    if (!user) return null;

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        OR: [
          { campaign: { userId: user.userId } },
          { mailbox: { userId: user.userId } },
          { assignedTo: user.userId }
        ]
      }
    });

    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return null;
    }

    return conversation;
  }
}
