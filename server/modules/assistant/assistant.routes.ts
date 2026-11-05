import express, { type Request, type Response } from 'express';

import { assistantService, startPatrols } from '@/modules/assistant/assistant.service.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

const router = express.Router();

// 10/20 P2: scheduled patrols tick once a minute from here on.
startPatrols();

// DHC CLI 10/19 團隊小助理: answers in the background and writes into the room itself, so this returns at once.
router.post(
  '/reply',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const outcome = assistantService.requestReply(Number((req as AuthenticatedRequest).user?.id), {
      roomId: body.roomId,
      triggerAt: body.triggerAt,
      profileId: body.profileId,
      aboutRoom: body.aboutRoom,
    });
    res.status(outcome.status).json(createApiSuccessResponse({ state: outcome.state }));
  }),
);

// 10/20 action cards: a press on 執行／取消 under an assistant reply.
router.post(
  '/actions/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const outcome = assistantService.decideCard(Number((req as AuthenticatedRequest).user?.id), req.params.id, {
      decision: body.decision,
      profileId: body.profileId,
    });
    res.status(outcome.status).json(createApiSuccessResponse({ state: outcome.state }));
  }),
);

router.get(
  '/cards',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse({
      cards: assistantService.cards(Number((req as AuthenticatedRequest).user?.id), req.query.roomId),
      next: assistantService.next(req.query.roomId),
    }));
  }),
);

router.get(
  '/status',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ running: assistantService.running(req.query.roomId), steps: assistantService.progress(req.query.roomId), trail: assistantService.trail(req.query.roomId) }));
  }),
);

// 11/02 試著問: example questions for an empty private chat with the assistant.
router.get(
  '/examples',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ examples: assistantService.examples(Number((req as AuthenticatedRequest).user?.id)) }));
  }),
);

// 10/21 停止: ends the answers still running in a room.
router.post(
  '/stop',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(createApiSuccessResponse({ stopped: assistantService.stop(body.roomId, body.profileId) }));
  }),
);

// 10/25 自建小助理: list, add, edit, delete own bots, 我的小助理個性, and the owner's answer to a borrow request.
router.get(
  '/bots',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(assistantService.bots(Number((req as AuthenticatedRequest).user?.id), req.query.profileId)));
  }),
);

router.post(
  '/bots',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ bot: assistantService.createBot(Number((req as AuthenticatedRequest).user?.id), (req.body ?? {}) as Record<string, unknown>) }));
  }),
);

router.post(
  '/bots/requests/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const outcome = assistantService.decideBorrow(Number((req as AuthenticatedRequest).user?.id), req.params.id, { decision: body.decision, by: body.by });
    res.status(outcome.status).json(createApiSuccessResponse({ state: outcome.state }));
  }),
);

router.put(
  '/bots/:id',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ bot: assistantService.updateBot(Number((req as AuthenticatedRequest).user?.id), req.params.id, (req.body ?? {}) as Record<string, unknown>) }));
  }),
);

router.delete(
  '/bots/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    assistantService.deleteBot(req.params.id, body.profileId ?? req.query.profileId);
    res.json(createApiSuccessResponse({ deleted: true }));
  }),
);

router.put(
  '/style',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ style: assistantService.saveStyle((req.body ?? {}) as Record<string, unknown>) }));
  }),
);

export default router;
