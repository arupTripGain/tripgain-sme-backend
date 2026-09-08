import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const getOrganizations = async (req: Request, res: Response): Promise<void> => {
  res.status(200).json({ message: 'getOrganizations not implemented' });
};

export const createOrganization = async (req: Request, res: Response): Promise<void> => {
  res.status(200).json({ message: 'createOrganization not implemented' });
};
