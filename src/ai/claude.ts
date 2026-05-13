import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { logger } from '../lib/logger.js';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeReply {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

/**
 * Call Sonnet 4.6 with the system prompt cached (5-min ephemeral TTL).
 * Rolling-window history is passed as plain user/assistant turns.
 */
export async function generateReply(history: ChatTurn[]): Promise<ClaudeReply> {
  if (history.length === 0) {
    throw new Error('generateReply called with empty history');
  }

  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: env.MAX_OUTPUT_TOKENS,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: history.map((t) => ({ role: t.role, content: t.content })),
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  const text = textBlock?.text.trim() ?? '';

  if (!text) {
    logger.warn({ stop_reason: response.stop_reason }, 'Claude returned no text');
  }

  return {
    text,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}
