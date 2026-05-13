import type { Channel, NormalizedMessage, OutboundReply, TransportAdapter } from './types.js';
import { logger } from '../lib/logger.js';

/**
 * Transport-agnostic router. Adapters register themselves; inbound messages
 * are dispatched to a single handler; outbound replies are routed back through
 * the matching adapter by channel.
 *
 * Adding a new channel = writing a new TransportAdapter + calling register().
 * The handler doesn't change.
 */
export class MessageRouter {
  private adapters = new Map<Channel, TransportAdapter>();
  private handler: ((msg: NormalizedMessage, router: MessageRouter) => Promise<void>) | null = null;

  register(adapter: TransportAdapter): void {
    if (this.adapters.has(adapter.channel)) {
      throw new Error(`Adapter for channel "${adapter.channel}" is already registered`);
    }
    this.adapters.set(adapter.channel, adapter);
    logger.info({ channel: adapter.channel }, 'Transport adapter registered');
  }

  setHandler(handler: (msg: NormalizedMessage, router: MessageRouter) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.handler) {
      throw new Error('Router.start() called before setHandler()');
    }
    const handler = this.handler;
    for (const adapter of this.adapters.values()) {
      await adapter.start(async (msg) => {
        try {
          await handler(msg, this);
        } catch (err) {
          logger.error({ err, channel: msg.channel, from: msg.phoneNumber }, 'Handler threw');
        }
      });
    }
  }

  async send(reply: OutboundReply): Promise<void> {
    const adapter = this.adapters.get(reply.channel);
    if (!adapter) {
      throw new Error(`No adapter registered for channel "${reply.channel}"`);
    }
    await adapter.send(reply);
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch (err) {
        logger.error({ err, channel: adapter.channel }, 'Adapter stop failed');
      }
    }
  }
}
