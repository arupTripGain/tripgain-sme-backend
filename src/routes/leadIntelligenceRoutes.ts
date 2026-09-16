import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken } from '../middleware/authMiddleware';

const requireAdminRole = (req: Request, res: Response, next: NextFunction): void => {
  const role = (req.user?.role || '').toUpperCase();
  if (role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden: Lead Intelligence is restricted to administrators only.' });
    return;
  }
  next();
};

import {
  uploadFileMiddleware,
  uploadSourceFile,
  processPastedText,
  processUrl,
  getSources,
  getSourceDetail,
  getLeads,
  getLeadDetail,
  overrideDedupeStatus,
  exportLeadsCsv,
  getBatches,
  getBatchDetail,
  cancelBatch,
  exportBatchCsv,
  deleteBatch,
} from '../controllers/leadIntelligenceController';

const router = Router();

// Apply auth and admin-only role guard to all lead intelligence routes
router.use(authenticateToken, requireAdminRole);

// Research Batch Endpoints
router.get('/batches', getBatches);
router.get('/batches/:id', getBatchDetail);
router.post('/batches/:id/cancel', cancelBatch);
router.get('/batches/:id/export', exportBatchCsv);
router.delete('/batches/:id', deleteBatch);

// Source Ingestion Endpoints
router.post('/sources/upload', uploadFileMiddleware, uploadSourceFile);
router.post('/sources/pasted-text', processPastedText);
router.post('/sources/url', processUrl);

// Source Retrieval Endpoints
router.get('/sources', getSources);
router.get('/sources/:id', getSourceDetail);

// Lead Retrieval, Filter, Detail, & Override Endpoints
router.get('/leads', getLeads);
router.get('/leads/:id', getLeadDetail);
router.post('/leads/:id/override-dedupe', overrideDedupeStatus);

// Export Endpoint
router.get('/export', exportLeadsCsv);

export default router;
