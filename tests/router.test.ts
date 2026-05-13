import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../src/messaging/router.js';
import type { NormalizedMessage, OutboundReply, TransportAdapter } from '../src/messaging/types.js';

/**
 * Transport-agnostic dispatch test: we register a fake adapter, fire a message
 * through it, and assert the handler sees a normalized message regardless of
 * channel — and that the outbound reply routes back through the right adapter.
 */
function makeFakeAdapter(channel: 'whatsapp' | 'sms'): {
  adapter: TransportAdapter;
  emit: (msg: NormalizedMessage) => Promise<void>;
  sent: OutboundReply[];
} {
  const sent: OutboundReply[] = [];
  let listener: ((msg: NormalizedMessage) => Promise<void>) | null = null;

  const adapter: TransportAdapter = {
    channel,
    async start(onMessage) {
      listener = onMessage;
    },
    async send(reply) {
      sent.push(reply);
    },
    async stop() {
      listener = null;
    },
  };

  const emit = async (msg: NormalizedMessage) => {
    if (!listener) throw new Error('adapter not started');
    await listener(msg);
  };

  return { adapter, emit, sent };
}

describe('MessageRouter', () => {
  it('dispatches inbound messages to the registered handler regardless of channel', async () => {
    const router = new MessageRouter();
    const wa = makeFakeAdapter('whatsapp');
    const sms = makeFakeAdapter('sms');

    router.register(wa.adapter);
    router.register(sms.adapter);

    const handler = vi.fn(async () => {});
    router.setHandler(handler);
    await router.start();

    const waMsg: NormalizedMessage = {
      phoneNumber: '+15551234567',
      channel: 'whatsapp',
      content: 'hello from whatsapp',
      receivedAt: new Date(),
    };
    const smsMsg: NormalizedMessage = {
      phoneNumber: '+15557654321',
      channel: 'sms',
      content: 'hello from sms',
      receivedAt: new Date(),
    };

    await wa.emit(waMsg);
    await sms.emit(smsMsg);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0]).toEqual(waMsg);
    expect(handler.mock.calls[1][0]).toEqual(smsMsg);
  });

  it('routes outbound replies back through the matching adapter', async () => {
    const router = new MessageRouter();
    const wa = makeFakeAdapter('whatsapp');
    const sms = makeFakeAdapter('sms');

    router.register(wa.adapter);
    router.register(sms.adapter);
    router.setHandler(async () => {});
    await router.start();

    await router.send({
      phoneNumber: '+15551234567',
      channel: 'whatsapp',
      content: 'reply via whatsapp',
    });
    await router.send({
      phoneNumber: '+15557654321',
      channel: 'sms',
      content: 'reply via sms',
    });

    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0].content).toBe('reply via whatsapp');
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0].content).toBe('reply via sms');
  });

  it('throws when sending to an unregistered channel', async () => {
    const router = new MessageRouter();
    router.register(makeFakeAdapter('whatsapp').adapter);
    router.setHandler(async () => {});
    await router.start();

    await expect(
      router.send({ phoneNumber: '+15551234567', channel: 'sms', content: 'x' }),
    ).rejects.toThrow(/No adapter/);
  });

  it('rejects duplicate adapter registration for the same channel', () => {
    const router = new MessageRouter();
    router.register(makeFakeAdapter('whatsapp').adapter);
    expect(() => router.register(makeFakeAdapter('whatsapp').adapter)).toThrow(/already registered/);
  });
});
