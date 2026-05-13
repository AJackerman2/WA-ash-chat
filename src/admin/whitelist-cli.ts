import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { db, schema, } from '../db/index.js';
import { logger } from '../lib/logger.js';

/**
 * Whitelist CLI.
 *
 * Usage:
 *   npm run whitelist -- add    +15551234567 [whatsapp]
 *   npm run whitelist -- remove +15551234567 [whatsapp]
 *   npm run whitelist -- list
 *
 * Defaults channel to "whatsapp" if omitted.
 */
async function main(): Promise<void> {
  const [, , cmd, phoneArg, channelArg] = process.argv;
  const channel = channelArg ?? 'whatsapp';

  if (cmd === 'list') {
    const rows = await db.select().from(schema.users).where(eq(schema.users.isWhitelisted, true));
    if (rows.length === 0) {
      console.log('No whitelisted users.');
    } else {
      console.log(`Whitelisted users (${rows.length}):`);
      for (const r of rows) {
        console.log(`  ${r.phoneNumber}  [${r.channel}]  status=${r.status}`);
      }
    }
    return;
  }

  if (!cmd || !phoneArg || (cmd !== 'add' && cmd !== 'remove')) {
    console.error('Usage:');
    console.error('  npm run whitelist -- add    +15551234567 [whatsapp]');
    console.error('  npm run whitelist -- remove +15551234567 [whatsapp]');
    console.error('  npm run whitelist -- list');
    process.exit(1);
  }

  const phoneNumber = normalizePhone(phoneArg);

  if (cmd === 'add') {
    const existing = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.phoneNumber, phoneNumber), eq(schema.users.channel, channel)))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(schema.users)
        .set({ isWhitelisted: true, updatedAt: new Date() })
        .where(eq(schema.users.id, existing[0].id));
      console.log(`Whitelisted existing user: ${phoneNumber} [${channel}]`);
    } else {
      await db.insert(schema.users).values({
        phoneNumber,
        channel,
        status: 'active',
        isWhitelisted: true,
      });
      console.log(`Created and whitelisted: ${phoneNumber} [${channel}]`);
    }
  } else {
    const result = await db
      .update(schema.users)
      .set({ isWhitelisted: false, updatedAt: new Date() })
      .where(and(eq(schema.users.phoneNumber, phoneNumber), eq(schema.users.channel, channel)))
      .returning({ id: schema.users.id });

    if (result.length === 0) {
      console.log(`No user found: ${phoneNumber} [${channel}]`);
    } else {
      console.log(`Removed from whitelist: ${phoneNumber} [${channel}]`);
    }
  }
}

function normalizePhone(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith('+')) {
    return `+${trimmed.replace(/\D/g, '')}`;
  }
  return `+${trimmed.slice(1).replace(/\D/g, '')}`;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'Whitelist CLI failed');
    process.exit(1);
  });
