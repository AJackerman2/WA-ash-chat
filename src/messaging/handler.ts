import { and, eq, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { generateReply, type ChatTurn } from '../ai/claude.js';
import type { MessageRouter } from './router.js';
import type { NormalizedMessage } from './types.js';

const NON_WHITELISTED_REPLY =
  "Hi — this is a private beta of ASH-ai, and your number isn't on the tester list. " +
  "If you think you should have access, reach out to whoever invited you.";

/**
 * Main message handler. Transport-agnostic: it takes a normalized message and
 * the router, looks the user up, runs the whitelist check, persists the
 * inbound message, calls Claude with rolling context, sends the reply back
 * through the router (which routes by channel), and persists the outbound.
 */
export async function handleMessage(msg: NormalizedMessage, router: MessageRouter): Promise<void> {
  const log = logger.child({ from: msg.phoneNumber, channel: msg.channel });
  log.info({ contentLen: msg.content.length }, 'Inbound message');

  if (msg.content.trim().length === 0) {
    log.debug('Skipping empty message');
    return;
  }

  // 1. Find or create the user (composite key: phone_number + channel).
  const user = await findOrCreateUser(msg.phoneNumber, msg.channel);

  // 2. Whitelist check. Non-whitelisted users get a polite one-time-ish reject.
  if (!user.isWhitelisted) {
    log.info('Non-whitelisted user — sending polite reject');
    await router.send({
      phoneNumber: msg.phoneNumber,
      channel: msg.channel,
      content: NON_WHITELISTED_REPLY,
    });
    return;
  }

  // 3. Ensure a conversation row. For Session 1 we keep a single rolling
  //    conversation per user; Session 2 may split by inactivity / session id.
  const conversation = await findOrCreateConversation(user.id);

  // 4. Persist inbound message before calling the model — so a model error
  //    doesn't lose the user's message.
  await db.insert(schema.messages).values({
    conversationId: conversation.id,
    channel: msg.channel,
    role: 'user',
    content: msg.content,
  });

  // 5. Pull rolling window. Fetch the most recent N (descending) then reverse
  //    to chronological order for Claude.
  const recent = await db
    .select({
      role: schema.messages.role,
      content: schema.messages.content,
    })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversation.id))
    .orderBy(desc(schema.messages.createdAt))
    .limit(env.CONTEXT_WINDOW_SIZE);

  const history: ChatTurn[] = recent
    .reverse()
    .filter((m): m is { role: 'user' | 'assistant'; content: string } =>
      m.role === 'user' || m.role === 'assistant',
    )
    .map((m) => ({ role: m.role, content: m.content }));

  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    // Safety: the message we just inserted should be the trailing user turn.
    log.warn('Rolling window has no trailing user turn — aborting');
    return;
  }

  // 6. Call Claude.
  let reply;
  try {
    reply = await generateReply(history);
  } catch (err) {
    log.error({ err }, 'Claude call failed');
    await router.send({
      phoneNumber: msg.phoneNumber,
      channel: msg.channel,
      content: "Sorry — I hit a snag on my end. Try me again in a moment.",
    });
    return;
  }

  if (!reply.text) {
    log.warn('Claude returned empty text; not replying');
    return;
  }

  log.info(
    {
      input: reply.usage.inputTokens,
      output: reply.usage.outputTokens,
      cacheRead: reply.usage.cacheReadTokens,
      cacheCreate: reply.usage.cacheCreationTokens,
    },
    'Claude reply generated',
  );

  // 7. Send reply via the transport.
  await router.send({
    phoneNumber: msg.phoneNumber,
    channel: msg.channel,
    content: reply.text,
  });

  // 8. Persist outbound with token counts; update conversation last_message_at.
  await db.insert(schema.messages).values({
    conversationId: conversation.id,
    channel: msg.channel,
    role: 'assistant',
    content: reply.text,
    inputTokens: reply.usage.inputTokens,
    outputTokens: reply.usage.outputTokens,
    cacheReadTokens: reply.usage.cacheReadTokens,
    cacheCreationTokens: reply.usage.cacheCreationTokens,
  });

  await db
    .update(schema.conversations)
    .set({ lastMessageAt: new Date() })
    .where(eq(schema.conversations.id, conversation.id));
}

async function findOrCreateUser(phoneNumber: string, channel: string) {
  const existing = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.phoneNumber, phoneNumber), eq(schema.users.channel, channel)))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const [created] = await db
    .insert(schema.users)
    .values({ phoneNumber, channel, status: 'active', isWhitelisted: false })
    .returning();
  return created;
}

async function findOrCreateConversation(userId: string) {
  const existing = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.userId, userId))
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const [created] = await db
    .insert(schema.conversations)
    .values({ userId })
    .returning();
  return created;
}
