import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { MessageRouter } from './messaging/router.js';
import { WhatsAppAdapter } from './messaging/adapters/whatsapp.js';
import { handleMessage } from './messaging/handler.js';
import { closeDb } from './db/index.js';

async function main(): Promise<void> {
  logger.info(
    { node: process.version, env: env.NODE_ENV, model: env.ANTHROPIC_MODEL },
    'ASH-ai starting',
  );

  const router = new MessageRouter();
  router.register(new WhatsAppAdapter());
  router.setHandler(handleMessage);

  await router.start();
  logger.info('Router started — listening for inbound messages');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    try {
      await router.stop();
      await closeDb();
    } catch (err) {
      logger.error({ err }, 'Shutdown error');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
