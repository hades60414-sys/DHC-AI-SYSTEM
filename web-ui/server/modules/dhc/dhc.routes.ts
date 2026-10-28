import express from 'express';

import { getDhcPublicConfig } from './dhc-config.js';
import { createUsageService } from './usage.service.js';

const router = express.Router();
const usage = createUsageService();
usage.start();

router.get('/config', (_request, response) => {
  response.json(getDhcPublicConfig());
});

// Claude subscription usage for the sidebar meters; the OAuth token stays on the server.
router.get('/usage', async (_request, response, next) => {
  try {
    response.set('cache-control', 'no-store').json(await usage.read());
  } catch (error) {
    next(error);
  }
});

export default router;
