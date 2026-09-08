import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../middleware/authMiddleware';

const prisma = new PrismaClient();

const getOrCreateDefaultWorkspace = async () => {
  let workspace = await prisma.workspace.findFirst({
    include: { user: true }
  });
  if (!workspace) {
    const adminUser = await prisma.user.upsert({
      where: { email: 'admin@tripgain.com' },
      update: {},
      create: {
        email: 'admin@tripgain.com',
        name: 'Arup Nirala',
        role: 'ADMIN',
        passwordHash: await bcrypt.hash('password123', 10)
      }
    });
    workspace = await prisma.workspace.create({
      data: {
        name: 'TripGain',
        userId: adminUser.id
      },
      include: { user: true }
    });
  }
  return workspace;
};

// ---------------------------------------------------------------------
// 1. User Login
// ---------------------------------------------------------------------
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const user = await prisma.user.findFirst({
      where: {
        email: { equals: normalizedEmail, mode: 'insensitive' }
      },
      include: {
        workspace: true,
        ownedWorkspaces: true
      }
    });

    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    let isPasswordValid = false;

    if (user.passwordHash) {
      isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    } else {
      // Legacy user fallback if password wasn't set yet
      if (password === 'password123' || password === 'admin' || password === 'admin123') {
        isPasswordValid = true;
        // Automatically upgrade password hash
        const hashed = await bcrypt.hash(password, 10);
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordHash: hashed }
        });
      }
    }

    if (!isPasswordValid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Determine active workspace
    let activeWorkspaceId = user.workspaceId || user.ownedWorkspaces[0]?.id;
    if (!activeWorkspaceId) {
      const defaultWs = await getOrCreateDefaultWorkspace();
      activeWorkspaceId = defaultWs.id;
      await prisma.user.update({
        where: { id: user.id },
        data: { workspaceId: activeWorkspaceId }
      });
    }

    const payload = {
      userId: user.id,
      email: user.email,
      name: user.name || user.email.split('@')[0],
      role: user.role || 'MEMBER',
      workspaceId: activeWorkspaceId
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.name || user.email.split('@')[0],
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl,
        workspaceId: activeWorkspaceId
      }
    });
  } catch (error: any) {
    console.error('Error during login:', error);
    res.status(500).json({ error: error?.message || 'Login failed' });
  }
};

// ---------------------------------------------------------------------
// 2. User Registration / Invite User
// ---------------------------------------------------------------------
export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, name, role } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const existingUser = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } }
    });

    if (existingUser) {
      res.status(400).json({ error: 'A user with this email already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const workspace = await getOrCreateDefaultWorkspace();

    const newUser = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: name?.trim() || normalizedEmail.split('@')[0],
        passwordHash,
        role: role || 'MEMBER',
        workspaceId: workspace.id
      }
    });

    const payload = {
      userId: newUser.id,
      email: newUser.email,
      name: newUser.name || '',
      role: newUser.role,
      workspaceId: workspace.id
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        avatarUrl: newUser.avatarUrl,
        workspaceId: workspace.id
      }
    });
  } catch (error: any) {
    console.error('Error registering user:', error);
    res.status(500).json({ error: error?.message || 'Failed to register user' });
  }
};

// ---------------------------------------------------------------------
// 3. Get Current User Profile (Me)
// ---------------------------------------------------------------------
export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      // Fallback to first admin user if unauthenticated
      const defaultUser = await prisma.user.findFirst({
        include: { workspace: true, ownedWorkspaces: true }
      });
      if (defaultUser) {
        res.status(200).json({
          user: {
            id: defaultUser.id,
            name: defaultUser.name,
            email: defaultUser.email,
            role: defaultUser.role,
            avatarUrl: defaultUser.avatarUrl,
            workspaceId: defaultUser.workspaceId || defaultUser.ownedWorkspaces[0]?.id
          },
          workspace: defaultUser.workspace || defaultUser.ownedWorkspaces[0]
        });
        return;
      }
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        workspace: true,
        ownedWorkspaces: true
      }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl,
        workspaceId: user.workspaceId || user.ownedWorkspaces[0]?.id
      },
      workspace: user.workspace || user.ownedWorkspaces[0]
    });
  } catch (error: any) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch user' });
  }
};

// ---------------------------------------------------------------------
// 4. List All Users (Team Management)
// ---------------------------------------------------------------------
export const getUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatarUrl: true,
        createdAt: true,
        workspaceId: true
      },
      orderBy: { createdAt: 'asc' }
    });

    res.status(200).json(users);
  } catch (error: any) {
    console.error('Error listing users:', error);
    res.status(500).json({ error: error?.message || 'Failed to list users' });
  }
};

// ---------------------------------------------------------------------
// 5. Delete User (Team Management)
// ---------------------------------------------------------------------
export const deleteUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = String(req.params.id);

    // Check if target user is primary workspace owner
    const target = await prisma.user.findUnique({
      where: { id: userId },
      include: { ownedWorkspaces: true }
    });

    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const owned = (target as any).ownedWorkspaces || [];
    if (owned.length > 0 && target.role === 'ADMIN') {
      const otherAdmins = await prisma.user.count({
        where: { role: 'ADMIN', id: { not: userId } }
      });
      if (otherAdmins === 0) {
        res.status(400).json({ error: 'Cannot delete the only workspace administrator' });
        return;
      }
    }

    await prisma.user.delete({ where: { id: userId } });

    res.status(200).json({ success: true, message: 'User deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: error?.message || 'Failed to delete user' });
  }
};
