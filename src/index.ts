import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';

// Force load .env from the backend directory with override so nothing is skipped
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
dotenv.config({ override: true });

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Normalize Vercel multi-service rewrites (/api/backend/...)
app.use((req, res, next) => {
  if (req.url.startsWith('/api/backend')) {
    req.url = req.url.replace('/api/backend', '') || '/';
  }
  next();
});

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'TripGain SME Outreach Backend API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

import { createContact, getContacts, getContactById, bulkImportContacts, deleteContact, bulkDeleteContacts, updateContact, exportContacts } from './controllers/contactController';
import { personalizeContact, editPersonalization, startBulkPersonalization, getBulkJobStatus, getListPersonalizationStats } from './controllers/personalizationController';
import { createOrganization, getOrganizations } from './controllers/organizationController';
import { createList, getLists, getListById, deleteList, addMembersToList, removeMembersFromList, updateList, duplicateList } from './controllers/listController';
import { getCampaigns, getCampaignById, composeCampaign, activateCampaign, pauseCampaign, duplicateCampaign, getCampaignLeads, updateCampaign, updateCampaignSteps, generateLeadDraft, updateEnrollmentStatus, enrollLeads, getCampaignAuditLogs, getEligibilityPreview, deleteCampaign } from './controllers/campaignController';
import { 
  getCampaignAnalytics, 
  getCampaignStepAnalytics, 
  getCampaignLinkAnalytics, 
  getCampaignContactAnalytics, 
  getContactTimeline, 
  exportCampaignAnalytics 
} from './controllers/campaignAnalyticsController';
import { getGlobalAnalytics } from './controllers/analyticsController';
import { getDashboardStats } from './controllers/dashboardController';
import { runTick } from './controllers/schedulerController';
import { processEmailScheduler } from './services/schedulerService';
import { getMailboxes, connectSmtpImap, disconnectMailbox, testMailbox, sendTestEmail, updateMailboxLimits, googleCallback, microsoftCallback } from './controllers/mailboxController';
import { login, register, getMe, getUsers, deleteUser } from './controllers/authController';
import { authenticateToken, optionalAuth } from './middleware/authMiddleware';

const upload = multer({ storage: multer.memoryStorage() });

// Global user identity & auth middleware (populates req.user if bearer token present)
app.use('/api', optionalAuth);

// Auth & Team routes
app.post('/api/auth/login', login);
app.post('/api/auth/register', register);
app.get('/api/auth/me', authenticateToken, getMe);
app.get('/api/auth/users', authenticateToken, getUsers);
app.post('/api/auth/users', authenticateToken, register);
app.delete('/api/auth/users/:id', authenticateToken, deleteUser);

// Contact routes (Strictly authenticated & user-isolated)
app.post('/api/contacts/bulk-personalize', authenticateToken, startBulkPersonalization);
app.get('/api/contacts/personalization-jobs/:jobId', authenticateToken, getBulkJobStatus);
app.post('/api/contacts/:id/personalize', authenticateToken, personalizeContact);
app.put('/api/contacts/:id/personalize', authenticateToken, editPersonalization);
app.post('/api/contacts/bulk-import', authenticateToken, bulkImportContacts);
app.post('/api/contacts', authenticateToken, createContact);
app.get('/api/contacts', authenticateToken, getContacts);
app.get('/api/contacts/:id', authenticateToken, getContactById);
app.put('/api/contacts/:id', authenticateToken, updateContact);
app.delete('/api/contacts/:id', authenticateToken, deleteContact);
app.post('/api/contacts/export', authenticateToken, exportContacts);
app.post('/api/contacts/bulk-delete', authenticateToken, bulkDeleteContacts);

// Organization routes
app.post('/api/organizations', authenticateToken, createOrganization);
app.get('/api/organizations', authenticateToken, getOrganizations);

// List routes (Strictly authenticated & user-isolated)
app.post('/api/lists', authenticateToken, createList);
app.get('/api/lists', authenticateToken, getLists);
app.get('/api/lists/:id/personalization-stats', authenticateToken, getListPersonalizationStats);
app.get('/api/lists/:id', authenticateToken, getListById);
app.put('/api/lists/:id', authenticateToken, updateList);
app.delete('/api/lists/:id', authenticateToken, deleteList);
app.post('/api/lists/:id/duplicate', authenticateToken, duplicateList);
app.post('/api/lists/:id/members', authenticateToken, addMembersToList);
app.delete('/api/lists/:id/members', authenticateToken, removeMembersFromList);

// Campaign routes (Strictly authenticated & user-isolated)
app.post('/api/campaigns/compose', authenticateToken, composeCampaign);
app.post('/api/campaigns/:id/activate', authenticateToken, activateCampaign);
app.post('/api/campaigns/:id/pause', authenticateToken, pauseCampaign);
app.post('/api/campaigns/:id/duplicate', authenticateToken, duplicateCampaign);
app.get('/api/campaigns', authenticateToken, getCampaigns);
app.get('/api/campaigns/eligibility', authenticateToken, getEligibilityPreview);
app.get('/api/campaigns/:id', authenticateToken, getCampaignById);
app.get('/api/campaigns/:id/audit-logs', authenticateToken, getCampaignAuditLogs);
app.get('/api/analytics', authenticateToken, getGlobalAnalytics);
app.get('/api/dashboard', authenticateToken, getDashboardStats);
app.get('/api/campaigns/:id/analytics', authenticateToken, getCampaignAnalytics);
app.get('/api/campaigns/:id/analytics/steps', authenticateToken, getCampaignStepAnalytics);
app.get('/api/campaigns/:id/analytics/links', authenticateToken, getCampaignLinkAnalytics);
app.get('/api/campaigns/:id/analytics/contacts', authenticateToken, getCampaignContactAnalytics);
app.get('/api/campaigns/:id/analytics/contacts/:enrollmentId/timeline', authenticateToken, getContactTimeline);
app.get('/api/campaigns/:id/analytics/export', authenticateToken, exportCampaignAnalytics);
app.get('/api/campaigns/:id/leads', authenticateToken, getCampaignLeads);
app.put('/api/campaigns/:id', authenticateToken, updateCampaign);
app.put('/api/campaigns/:id/steps', authenticateToken, updateCampaignSteps);
app.post('/api/campaigns/draft', authenticateToken, generateLeadDraft);
app.delete('/api/campaigns/:id', authenticateToken, deleteCampaign);

import { handleRedirect, handleOpenTracking } from './controllers/trackingController';
import { simulateEvent, handleProviderWebhook } from './controllers/webhookController';
import { getConversations, getConversationById, replyToConversation, performConversationAction, simulateLeadReply, syncReplies } from './controllers/uniboxController';
import aiRoutes from './routes/aiRoutes';

// AI Routes
app.use('/api/ai', authenticateToken, aiRoutes);

// Phase 6 Engine & Tracking
app.get('/api/scheduler/tick', runTick);
app.post('/api/scheduler/tick', runTick);
app.post('/api/webhooks/simulate-event', simulateEvent);
app.post('/api/webhooks/email-provider', handleProviderWebhook); // Phase 9
app.get('/t/:trackingToken', handleOpenTracking); // Open tracking pixel
app.get('/track/open/:trackingToken', handleOpenTracking);
app.get('/r/:trackingToken', handleRedirect); // Phase 9 click tracking
app.post('/api/campaigns/:id/enroll', authenticateToken, enrollLeads);
app.put('/api/campaigns/:id/enrollments/:enrollmentId/status', authenticateToken, updateEnrollmentStatus);

// Phase 10 Unibox (Strictly authenticated & user-isolated)
app.get('/api/unibox', authenticateToken, getConversations);
app.post('/api/unibox/simulate-reply', authenticateToken, simulateLeadReply);
app.post('/api/unibox/sync', authenticateToken, syncReplies);
app.get('/api/unibox/:id', authenticateToken, getConversationById);
app.post('/api/unibox/:id/reply', authenticateToken, replyToConversation);
app.post('/api/unibox/:id/:action', authenticateToken, performConversationAction);

// Phase 7 Mailboxes (Strictly authenticated & user-isolated)
app.get('/api/mailboxes', authenticateToken, getMailboxes);
app.post('/api/mailboxes/smtp-imap', authenticateToken, connectSmtpImap);
app.delete('/api/mailboxes/:id', authenticateToken, disconnectMailbox);
app.put('/api/mailboxes/:id', authenticateToken, updateMailboxLimits);
app.patch('/api/mailboxes/:id/limits', authenticateToken, updateMailboxLimits);
app.post('/api/mailboxes/:id/test', authenticateToken, testMailbox);
app.post('/api/mailboxes/:id/send-test', authenticateToken, sendTestEmail);
app.get('/api/integrations/google/callback', googleCallback);
app.get('/api/integrations/microsoft/callback', microsoftCallback);

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Backend server is running on port ${port}`);

    // Automated background scheduler runner for local development only
    // In production / Vercel, scheduler execution is driven by an external cron caller
    if (process.env.NODE_ENV !== 'production') {
      console.log('[Scheduler] Initializing local 60s interval runner...');
      setInterval(() => {
        processEmailScheduler().catch(err => {
          console.error('[Background Scheduler Interval Error]:', err);
        });
      }, 60000);
    }
  });
}

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit();
});

export default app;
