/**
 * Channel identifier. New channels (sms, telegram, etc.) are added as string
 * literals here and an adapter implementing TransportAdapter for that channel.
 */
export type Channel = 'whatsapp' | 'sms' | 'telegram';

/**
 * Normalized inbound message — what the handler sees, independent of transport.
 * phone_number is E.164 (with leading +); content is plain text only for Session 1.
 */
export interface NormalizedMessage {
  phoneNumber: string;
  channel: Channel;
  content: string;
  receivedAt: Date;
  /** Optional transport-specific message id, useful for idempotency / logs. */
  externalId?: string;
}

/**
 * Outbound reply produced by the handler, routed back through the matching adapter.
 */
export interface OutboundReply {
  phoneNumber: string;
  channel: Channel;
  content: string;
}

/**
 * Every transport adapter implements this contract. The handler never imports
 * Baileys / Twilio / etc. directly — it only talks to the router, which talks
 * to whichever adapter matches the message's channel.
 */
export interface TransportAdapter {
  readonly channel: Channel;
  /** Begin listening; new inbound messages are pushed to onMessage. */
  start(onMessage: (msg: NormalizedMessage) => Promise<void>): Promise<void>;
  /** Send an outbound reply on this transport. */
  send(reply: OutboundReply): Promise<void>;
  /** Shut down cleanly. */
  stop(): Promise<void>;
}
