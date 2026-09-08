import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const JWT_SECRET = process.env.JWT_SECRET || 'tripgain_kinetic_super_secret_jwt_key_2026';

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
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
      req.user = decoded;
      return next();
    } catch (error) {
      // Continue to check fallback headers
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
        return next();
      }
    } catch (e) {
      // Ignore
    }
  }

  res.status(401).json({ error: 'Access token or user credentials required' });
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
