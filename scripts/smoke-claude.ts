/**
 * Smoke test for the Anthropic integration.
 *
 * Sends a tiny two-turn conversation to the model with the cached system
 * prompt, prints the reply and the usage block. Run twice to verify
 * cache_read_input_tokens > 0 on the second call.
 *
 * Usage: tsx scripts/smoke-claude.ts
 */
import 'dotenv/config';
import { generateReply } from '../src/ai/claude.js';
import { logger } from '../src/lib/logger.js';

async function main() {
  logger.info('Smoke test: first call (writes cache)');
  const r1 = await generateReply([
    { role: 'user', content: 'In one short sentence, what is challah?' },
  ]);
  console.log('--- reply 1 ---');
  console.log(r1.text);
  console.log('usage:', r1.usage);

  logger.info('Smoke test: second call (should hit cache)');
  const r2 = await generateReply([
    { role: 'user', content: 'In one short sentence, what is cholent?' },
  ]);
  console.log('--- reply 2 ---');
  console.log(r2.text);
  console.log('usage:', r2.usage);

  if (r2.usage.cacheReadTokens > 0) {
    console.log('\n✅ Prompt caching confirmed: cacheReadTokens =', r2.usage.cacheReadTokens);
  } else {
    console.log('\n⚠️  cacheReadTokens is 0 — system prompt may be below the cacheable minimum');
    console.log('   (Sonnet 4.6 minimum is 2048 tokens; very short system prompts won\'t cache)');
  }
}

main().catch((err) => {
  logger.error({ err }, 'Smoke test failed');
  process.exit(1);
});
