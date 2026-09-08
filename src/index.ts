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

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

import { createContact, getContacts, getContactById, bulkImportContacts, deleteContact, bulkDeleteContacts, updateContact, exportContacts } from './controllers/contactController';
import { personalizeContact, editPersonalization, startBulkPersonalization, getBulkJobStatus, getListPersonalizationStats } from './controllers/personalizationController';
import { createOrganization, getOrganizations } from './controllers/organizationController';
import { createList, getLists, getListById, deleteList, addMembersToList, removeMembersFromList, updateList, duplicateList } from './controllers/listController';
import { getCampaigns, getCampaignById, composeCampaign, activateCampaign, pauseCampaign, duplicateCampaign, getCampaignLeads, updateCampaign, updateCampaignSteps, generateLeadDraft, updateEnrollmentStatus, enrollLeads, getCampaignAuditLogs, getEligibilityPreview, deleteCampaign } from './controllers/campaignController';
import { getCampaignAnalytics } from './controllers/campaignAnalyticsController';
import { getGlobalAnalytics } from './controllers/analyticsController';
import { getDashboardStats } from './controllers/dashboardController';
import { runTick } from './controllers/schedulerController';
import { processEmailScheduler } from './services/schedulerService';
import { getMailboxes, connectSmtpImap, disconnectMailbox, testMailbox, sendTestEmail, updateMailboxLimits, googleCallback, microsoftCallback } from './controllers/mailboxController';
import { login, register, getMe, getUsers, deleteUser } from './controllers/authController';
import { authenticateToken, optionalAuth } from './middleware/authMiddleware';

const upload = multer({ dest: 'uploads/' });

// Global user identity & auth middleware
app.use('/api', optionalAuth);

// Auth & Team routes
app.post('/api/auth/login', login);
app.post('/api/auth/register', register);
app.get('/api/auth/me', optionalAuth, getMe);
app.get('/api/auth/users', optionalAuth, getUsers);
app.post('/api/auth/users', optionalAuth, register);
app.delete('/api/auth/users/:id', optionalAuth, deleteUser);

// Contact routes
app.post('/api/contacts/bulk-personalize', startBulkPersonalization);
app.get('/api/contacts/personalization-jobs/:jobId', getBulkJobStatus);
app.post('/api/contacts/:id/personalize', personalizeContact);
app.put('/api/contacts/:id/personalize', editPersonalization);
app.post('/api/contacts/bulk-import', bulkImportContacts);
app.post('/api/contacts', createContact);
app.get('/api/contacts', getContacts);
app.get('/api/contacts/:id', getContactById);
app.put('/api/contacts/:id', updateContact);
app.delete('/api/contacts/:id', deleteContact);
app.post('/api/contacts/export', exportContacts);
app.post('/api/contacts/bulk-delete', bulkDeleteContacts);

// Organization routes
app.post('/api/organizations', createOrganization);
app.get('/api/organizations', getOrganizations);

// List routes
app.post('/api/lists', createList);
app.get('/api/lists', getLists);
app.get('/api/lists/:id/personalization-stats', getListPersonalizationStats);
app.get('/api/lists/:id', getListById);
app.put('/api/lists/:id', updateList);
app.delete('/api/lists/:id', deleteList);
app.post('/api/lists/:id/duplicate', duplicateList);
app.post('/api/lists/:id/members', addMembersToList);
app.delete('/api/lists/:id/members', removeMembersFromList);

// Campaign routes
app.post('/api/campaigns/compose', composeCampaign);
app.post('/api/campaigns/:id/activate', activateCampaign);
app.post('/api/campaigns/:id/pause', pauseCampaign);
app.post('/api/campaigns/:id/duplicate', duplicateCampaign);
app.get('/api/campaigns', getCampaigns);
app.get('/api/campaigns/eligibility', getEligibilityPreview);
app.get('/api/campaigns/:id', getCampaignById);
app.get('/api/campaigns/:id/audit-logs', getCampaignAuditLogs);
app.get('/api/analytics', getGlobalAnalytics);
app.get('/api/dashboard', getDashboardStats);
app.get('/api/campaigns/:id/analytics', getCampaignAnalytics);
app.get('/api/campaigns/:id/leads', getCampaignLeads);
app.put('/api/campaigns/:id', updateCampaign);
app.put('/api/campaigns/:id/steps', updateCampaignSteps);
app.post('/api/campaigns/draft', generateLeadDraft);
app.delete('/api/campaigns/:id', deleteCampaign);

import { handleRedirect, handleOpenTracking } from './controllers/trackingController';
import { simulateEvent, handleProviderWebhook } from './controllers/webhookController';
import { getConversations, getConversationById, replyToConversation, performConversationAction, simulateLeadReply, syncReplies } from './controllers/uniboxController';
import aiRoutes from './routes/aiRoutes';

// AI Routes
app.use('/api/ai', aiRoutes);

// Phase 6 Engine & Tracking
app.get('/api/scheduler/tick', runTick);
app.post('/api/scheduler/tick', runTick);
app.post('/api/webhooks/simulate-event', simulateEvent);
app.post('/api/webhooks/email-provider', handleProviderWebhook); // Phase 9
app.get('/t/:trackingToken', handleOpenTracking); // Open tracking pixel
app.get('/track/open/:trackingToken', handleOpenTracking);
app.get('/r/:trackingToken', handleRedirect); // Phase 9 click tracking
app.post('/api/campaigns/:id/enroll', enrollLeads);
app.put('/api/campaigns/:id/enrollments/:enrollmentId/status', updateEnrollmentStatus);

// Phase 10 Unibox
app.get('/api/unibox', getConversations);
app.post('/api/unibox/simulate-reply', simulateLeadReply);
app.post('/api/unibox/sync', syncReplies);
app.get('/api/unibox/:id', getConversationById);
app.post('/api/unibox/:id/reply', replyToConversation);
app.post('/api/unibox/:id/:action', performConversationAction);

// Phase 7 Mailboxes
app.get('/api/mailboxes', getMailboxes);
app.post('/api/mailboxes/smtp-imap', connectSmtpImap);
app.delete('/api/mailboxes/:id', disconnectMailbox);
app.put('/api/mailboxes/:id', updateMailboxLimits);
app.patch('/api/mailboxes/:id/limits', updateMailboxLimits);
app.post('/api/mailboxes/:id/test', testMailbox);
app.post('/api/mailboxes/:id/send-test', sendTestEmail);
app.get('/api/integrations/google/callback', googleCallback);
app.get('/api/integrations/microsoft/callback', microsoftCallback);

app.listen(port, () => {
  console.log(`Backend server is running on port ${port}`);

  // Automated background scheduler runner for local development only
  // In production / Vercel, scheduler execution is driven by an external cron caller
  if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    console.log('[Scheduler] Initializing local 60s interval runner...');
    setInterval(() => {
      processEmailScheduler().catch(err => {
        console.error('[Background Scheduler Interval Error]:', err);
      });
    }, 60000);
  } else {
    console.log('[Scheduler] In-process interval runner disabled in production/Vercel (managed via external cron).');
  }
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit();
});

export default app;
