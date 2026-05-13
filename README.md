# ASH-ai Chat Bot

POC AI chat over WhatsApp. Warm, frum-friendly companion. Sonnet 4.6 backend with prompt caching. Transport-agnostic so SMS or other channels can be added later without touching the handler.

This is **Session 1** of a multi-session build. Session 2 will add persistent memory; Session 3, premium features; Session 4, billing.

---

## Architecture

```
WhatsApp ──┐
  (Baileys │
  adapter) │       ┌────────────────────┐       ┌──────────────┐
           ├──────▶│   MessageRouter    │──────▶│   handler    │
SMS ───────┤       │ (channel-agnostic) │       │  (whitelist, │
  (future) │       └──────────┬─────────┘       │   persist,   │
           │                  ▲                  │   roll ctx,  │
Telegram ──┘                  │                  │   call LLM)  │
                              │                  └──────┬───────┘
                              │                         │
                              └─────────────────────────┘
                                       (reply via the right channel)

   ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
   │  Neon (PG)   │    │ Anthropic    │    │  Baileys auth    │
   │  users,      │    │ Sonnet 4.6   │    │  state (./auth/) │
   │  conversa-   │    │ +caching     │    │  file-based,     │
   │  tions,      │    └──────────────┘    │  persistent      │
   │  messages,   │                        └──────────────────┘
   │  memory      │
   └──────────────┘
```

Adding a new channel = one new file implementing `TransportAdapter`. The handler doesn't change.

---

## Stack & decisions

| Choice | Why |
|---|---|
| **TypeScript + Node 20** | Baileys is in-process JS; TS gives us safety without the bundle cost. |
| **No HTTP framework** | Bot runs entirely off Baileys' socket events. No need for Express/Fastify in Session 1 — adds zero value here. |
| **Drizzle + Drizzle-kit migrations** | Lightweight, TS-native, plays nicely with Neon's pooler. |
| **`postgres` client (not `pg`)** | Drizzle's recommended driver for Neon; better pooling defaults. |
| **`@whiskeysockets/baileys`** | Active fork of the original (which is unmaintained). |
| **File-based Baileys auth state (`./auth/`)** | Simpler than DB-backed, well-trodden, survives restarts. Gitignored. If the box is rebuilt, you re-pair — for a POC that's fine. |
| **Pino logger** | Fast, structured, zero-config. |
| **PM2** | Mature, restart-safe, single config file. systemd would also work; PM2 is friendlier for an ops-of-one. |
| **Vitest** | Faster than Jest, same API. |

---

## Database schema

| Table | Purpose | Key columns |
|---|---|---|
| `users` | One row per phone+channel | `phone_number`, `channel`, `status`, `is_whitelisted`. Unique on `(phone_number, channel)`. |
| `conversations` | One per user (Session 1) | `user_id`, `started_at`, `last_message_at` |
| `messages` | Every inbound and outbound message | `conversation_id`, `channel`, `role`, `content`, token counts, `created_at` |
| `memory` | **Session 2** — not used yet | `user_id`, `content`, `updated_at` |

Migrations live in `drizzle/`. Run `npm run db:migrate` to apply.

---

## System prompt

Lives in `src/ai/system-prompt.ts`. Edit it there; PR review the changes.

Key behaviors encoded:

- Warm, frum-friendly voice; conversational; plain text (no markdown).
- Defers halachic shailos to "your rav". Will give descriptive halachic info but won't pasken.
- Doesn't moralize, push hashkafa, or claim certainty about individual minhagim.
- Defers medical / legal / mental health appropriately.

The prompt is sized to sit above Sonnet 4.6's 2048-token minimum cacheable prefix, so prompt caching activates from message 2 onward in a conversation. Confirmed via `cache_read_input_tokens` in the API response.

---

## Whitelisting

Direct DB / CLI. There's no admin endpoint and no auth in Session 1 — keep it simple.

```bash
# add
npm run whitelist -- add +15551234567

# remove
npm run whitelist -- remove +15551234567

# list
npm run whitelist -- list
```

Defaults the channel to `whatsapp`. Pass a second arg for other channels later.

A non-whitelisted number gets a polite one-shot reply explaining it's a private beta. Inbound messages from non-whitelisted users are not persisted (they don't get a user row beyond the initial create-on-first-contact, which stays `is_whitelisted=false`).

---

## Run locally

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# edit .env: DATABASE_URL, ANTHROPIC_API_KEY

# 3. Migrate
npm run db:migrate

# 4. Whitelist your test phones
npm run whitelist -- add +15551234567

# 5. Dev mode (auto-reload)
npm run dev
# OR production mode
npm run build && npm start
```

On first run a QR code prints to the terminal. Open WhatsApp on the bot's phone → Settings → Linked Devices → Link a Device → scan. Auth state is saved to `./auth/` and reused across restarts.

---

## Deploy to Hetzner

Designed for the Hetzner CX22 instance allocated to this project (Debian/Ubuntu base). The complete first-time deploy is in `scripts/deploy-hetzner.sh` — copy it to the box and run.

### One-time setup

SSH into the box (`ssh root@<HETZNER_IP>`) and run:

```bash
# Node 20 + git + build tools
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git build-essential
npm install -g pm2

# Clone
mkdir -p /opt && cd /opt
git clone https://github.com/AJackerman2/WA-ash-chat.git wa-ash-chat
cd wa-ash-chat
git checkout claude/setup-whatsapp-bot-00mBU   # or main once merged

# Configure
cp .env.example .env
nano .env   # paste DATABASE_URL and ANTHROPIC_API_KEY

# Install + build
npm ci
npm run build

# Run migrations
npm run db:migrate

# Whitelist testers
npm run whitelist -- add +19179240018
npm run whitelist -- add +972553377952
npm run whitelist -- add +19293555631

# Start under PM2
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 logs wa-ash-chat   # watch for the QR code, scan it from the bot phone
# Ctrl-C to detach from logs (the bot keeps running)

# Make PM2 start on boot
pm2 save
pm2 startup   # follow the printed instructions (one-time)
```

### Updating

```bash
cd /opt/wa-ash-chat
git pull
npm ci
npm run build
npm run db:migrate   # only if schema changed
pm2 restart wa-ash-chat
```

### Watching it

```bash
pm2 logs wa-ash-chat        # tail logs
pm2 status                  # is it running?
pm2 monit                   # interactive monitor
```

### If WhatsApp pairing breaks

If you see `WhatsApp session was logged out from the phone` in logs, the auth state is dead (someone removed the linked device, or WhatsApp invalidated it). To re-pair:

```bash
pm2 stop wa-ash-chat
rm -rf auth/
pm2 start wa-ash-chat
pm2 logs wa-ash-chat   # scan the new QR
```

---

## Project layout

```
src/
├── index.ts                     # entry; wires router + adapters + handler
├── config/env.ts                # env loading + validation
├── lib/logger.ts                # pino instance
├── db/
│   ├── schema.ts                # Drizzle schema
│   ├── index.ts                 # db client
│   └── migrate.ts               # migration runner
├── ai/
│   ├── system-prompt.ts         # the prompt
│   └── claude.ts                # Anthropic client + caching
├── messaging/
│   ├── types.ts                 # NormalizedMessage, OutboundReply, TransportAdapter
│   ├── router.ts                # MessageRouter (transport-agnostic)
│   ├── handler.ts               # business logic: whitelist, persist, LLM
│   └── adapters/
│       └── whatsapp.ts          # Baileys adapter
└── admin/
    └── whitelist-cli.ts         # `npm run whitelist`
tests/
└── router.test.ts               # router contract tests
scripts/
├── smoke-claude.ts              # `npx tsx scripts/smoke-claude.ts`
└── deploy-hetzner.sh            # one-shot first-time deploy
drizzle/                          # generated migration SQL
auth/                             # Baileys session (gitignored)
```

---

## What's NOT in Session 1

- **Persistent memory** — schema exists, not used. Session 2.
- **Voice notes, image input/output** — Session 3.
- **Stripe billing** — Session 4.
- **Tier enforcement** — Session 4.
- **Group chats** — out of scope; the adapter filters them out.
- **Non-text WhatsApp messages** (images, audio, stickers, etc.) — ignored for now.
- **Admin HTTP endpoint** — direct CLI only.

---

## Notes on the credentials

The `.env` file is gitignored. **Rotate the production credentials after each Session** — Anthropic API key, Neon password — they tend to drift through chat history, screenshots, etc. during development. Anthropic console → API Keys; Neon console → project → Settings → Reset password.
