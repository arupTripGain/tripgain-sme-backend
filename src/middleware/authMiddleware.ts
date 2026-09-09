import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const JWT_SECRET = process.env.JWT_SECRET || 'tripgain_dev_jwt_secret_change_in_production';

export interface AuthUser {
  userId: string;
  email: string;
  name?: string | undefined;
  role: string;
  workspaceId?: string | undefined;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const authenticateToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (token) {
    if (!JWT_SECRET) {
      res.status(500).json({ error: 'Server configuration error: JWT_SECRET not set' });
      return;
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
      req.user = decoded;
      return next();
    } catch (error: any) {
      res.status(401).json({ error: 'Invalid or expired access token. Please log in again.' });
      return;
    }
  }

  // Development/Header fallback (only when no token was provided)
  const headerEmail = (req.headers['x-user-email'] as string) || (req.query.userEmail as string);
  const headerUserId = (req.headers['x-user-id'] as string) || (req.query.userId as string);

  if (headerEmail || headerUserId) {
    try {
      const u = await prisma.user.findFirst({
        where: headerUserId ? { id: headerUserId } : { email: headerEmail }
      });
      if (u) {
        req.user = {
          userId: u.id,
          email: u.email,
          name: u.name || undefined,
          role: u.role,
          workspaceId: u.workspaceId || undefined
        };
        return next();
      }
    } catch (e) {
      // Ignore
    }
  }

  res.status(401).json({ error: 'Authentication required. Please provide a valid Bearer token.' });
};

export const optionalAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
      req.user = decoded;
      return next();
    } catch (e) {
      // Ignore error for optional auth
    }
  }

  // Fallback to x-user-email or x-user-id
  const headerEmail = (req.headers['x-user-email'] as string) || (req.query.userEmail as string);
  const headerUserId = (req.headers['x-user-id'] as string) || (req.query.userId as string);

  if (headerEmail || headerUserId) {
    try {
      const u = await prisma.user.findFirst({
        where: headerUserId ? { id: headerUserId } : { email: headerEmail }
      });
      if (u) {
        req.user = {
          userId: u.id,
          email: u.email,
          name: u.name || undefined,
          role: u.role,
          workspaceId: u.workspaceId || undefined
        };
      }
    } catch (e) {
      // Ignore
    }
  }

  next();
};
