import { Router } from 'express';
import {
  getDashboard,
  startVerificationJob,
  getJobStatus,
  cancelJob,
  getJobResults,
  exportResults,
  createCleanList,
  updateList,
  getListHistory,
  getWorkerStatus,
  diagnoseEmail
} from '../controllers/listGuardController';

const router = Router();

// Dashboard & Worker Status
router.get('/dashboard', getDashboard);
router.get('/worker-status', getWorkerStatus);
router.get('/diagnose', diagnoseEmail);

// Verification Jobs
router.post('/jobs', startVerificationJob);
router.get('/jobs/:jobId', getJobStatus);
router.post('/jobs/:jobId/cancel', cancelJob);

// Results & Actions
router.get('/jobs/:jobId/results', getJobResults);
router.get('/jobs/:jobId/export', exportResults);
router.post('/jobs/:jobId/create-list', createCleanList);
router.post('/jobs/:jobId/update-list', updateList);

// History
router.get('/lists/:listId/history', getListHistory);

export default router;
