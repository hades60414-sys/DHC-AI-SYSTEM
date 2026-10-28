// DHC CLI night queue: the HTTP surface the composer's night-mode button talks to.
export { default as nightQueueRoutes } from './night-queue.routes.js';

// The single-lane dispatcher that runs stored prompts from 02:00, started and stopped with the server.
export {
  initializeNightQueueDispatcher,
  closeNightQueueDispatcher,
} from './services/night-queue-dispatcher.service.js';
