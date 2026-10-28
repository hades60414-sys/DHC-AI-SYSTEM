import express from 'express';
import type { Request, Response } from 'express';

import { nightQueueService, readModeSettings, readStartAt } from '@/modules/night-queue/services/night-queue.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', {
      code: 'USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required.`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value;
}

const router = express.Router();

// DHC CLI sidebar: which sessions get a moon.
router.get(
  '/sessions',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ sessions: nightQueueService.listMarks() }));
  }),
);

router.get(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(nightQueueService.getState(readString(req.params.sessionId, 'sessionId'))));
  }),
);

router.put(
  '/sessions/:sessionId/mode',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== 'boolean') {
      throw new AppError('enabled must be true or false.', {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }
    res.json(createApiSuccessResponse(
      nightQueueService.setEnabled(
        readString(req.params.sessionId, 'sessionId'),
        body.enabled,
        body.enabled ? readModeSettings(body) : undefined,
      ),
    ));
  }),
);

router.post(
  '/sessions/:sessionId/items',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const state = nightQueueService.enqueue({
      userId: readUserId(req),
      sessionId: readString(req.params.sessionId, 'sessionId'),
      // Empty text is fine when attachments come with it; the service decides.
      content: typeof body.content === 'string' ? body.content : '',
      options: body.options,
      // The settings the composer showed; they apply when the session has none yet (a new chat).
      mode: body.mode === undefined ? undefined : readModeSettings(body.mode),
      // This prompt's own start time ("@12:05" at its start), over the session's default.
      startAt: readStartAt(body.startAt),
    });
    res.status(201).json(createApiSuccessResponse(state));
  }),
);

router.post(
  '/sessions/:sessionId/run-now',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(nightQueueService.runNow(readString(req.params.sessionId, 'sessionId'))));
  }),
);

router.post(
  '/sessions/:sessionId/cancel-all',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(nightQueueService.cancelAll(readString(req.params.sessionId, 'sessionId'))));
  }),
);

router.delete(
  '/items/:id',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(nightQueueService.cancel(readString(req.params.id, 'id'))));
  }),
);

export default router;
