import { Router } from 'express';
import { generateTemplate } from '../controllers/aiController';

const router = Router();

router.post('/generate-template', generateTemplate);

export default router;
