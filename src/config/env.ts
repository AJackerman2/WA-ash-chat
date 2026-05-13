import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got "${v}"`);
  return n;
}

export const env = {
  NODE_ENV: optional('NODE_ENV', 'development'),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),

  DATABASE_URL: required('DATABASE_URL'),
  ANTHROPIC_API_KEY: required('ANTHROPIC_API_KEY'),

  AUTH_DIR: optional('AUTH_DIR', './auth'),

  ANTHROPIC_MODEL: optional('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
  CONTEXT_WINDOW_SIZE: optionalInt('CONTEXT_WINDOW_SIZE', 20),
  MAX_OUTPUT_TOKENS: optionalInt('MAX_OUTPUT_TOKENS', 1024),

  BOT_NAME: optional('BOT_NAME', 'ASH-ai'),

  // E.164 phone number for the bot's WhatsApp account (with or without "+").
  // When set, the adapter requests an 8-character pairing code on first run
  // instead of printing a QR. Easier to use from a mobile SSH client and less
  // likely to trip WhatsApp's anti-abuse than rapid QR re-scans. Leave empty
  // to fall back to QR pairing.
  BOT_PHONE_NUMBER: optional('BOT_PHONE_NUMBER', ''),
} as const;

export type Env = typeof env;
