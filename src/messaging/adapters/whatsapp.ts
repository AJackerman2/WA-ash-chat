import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import type { NormalizedMessage, OutboundReply, TransportAdapter } from '../types.js';

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const ADAPTER_VERSION = 'lid-diagnostic-v3';

/**
 * Baileys-backed WhatsApp transport adapter.
 *
 * Auth state: file-based via useMultiFileAuthState(env.AUTH_DIR). Chosen over
 * DB-based storage because it's simpler, well-trodden, and survives restarts
 * as long as the directory persists. Document this choice in the README.
 *
 * Reconnect: on connection close we inspect the disconnect reason; everything
 * except "logged out" reconnects with bounded exponential backoff. Logged-out
 * means the auth state is dead — operator action required (delete auth/ and
 * re-pair).
 */
export class WhatsAppAdapter implements TransportAdapter {
  readonly channel = 'whatsapp' as const;

  private sock: WASocket | null = null;
  private onMessage: ((msg: NormalizedMessage) => Promise<void>) | null = null;
  private stopping = false;
  private reconnectAttempt = 0;
  // Dump the FULL raw inbound message exactly once per process lifetime so we
  // can see every field Baileys ships. Diagnostic only — flip to false to
  // disable once LID handling is solid.
  private rawDumpRemaining = 1;

  async start(onMessage: (msg: NormalizedMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(env.AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(
      { version, isLatest, adapterVersion: ADAPTER_VERSION },
      'Baileys version resolved',
    );

    // Pairing-code mode: if BOT_PHONE_NUMBER is set and we don't yet have
    // creds, ask WhatsApp for an 8-char code the user types into their phone.
    // Less anti-abuse-flag-prone than QR (in observation) and much easier to
    // surface through a mobile SSH client. If BOT_PHONE_NUMBER is empty, fall
    // back to QR pairing (still useful for desktop terminals).
    const usePairingCode = !state.creds.registered && env.BOT_PHONE_NUMBER.length > 0;

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false, // we render it ourselves below
      browser: [env.BOT_NAME, 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    if (usePairingCode) {
      // Baileys needs ~3s after socket creation before requestPairingCode
      // works — the noise handshake has to complete. Conventional delay from
      // the upstream examples.
      setTimeout(async () => {
        try {
          const phoneNumber = env.BOT_PHONE_NUMBER.replace(/\D/g, '');
          const code = await this.sock!.requestPairingCode(phoneNumber);
          const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
          logger.info('═══════════════════════════════════════════════');
          logger.info(`  WhatsApp pairing code: ${pretty}`);
          logger.info(`  Phone number: +${phoneNumber}`);
          logger.info('  On the bot phone, open WhatsApp:');
          logger.info('    Settings → Linked Devices → Link a device →');
          logger.info('    "Link with phone number instead" →');
          logger.info(`    enter the code above (${pretty})`);
          logger.info('═══════════════════════════════════════════════');
        } catch (err) {
          logger.error({ err }, 'Failed to request pairing code');
        }
      }, 3000);
    }

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Only print a QR if pairing-code mode wasn't activated.
      if (qr && !usePairingCode) {
        logger.info('WhatsApp pairing QR — scan from the bot phone now:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.reconnectAttempt = 0;
        const me = this.sock?.user;
        logger.info({ me: me?.id, name: me?.name }, 'WhatsApp connection open');
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error as Boom | undefined;
        const statusCode = err?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        logger.warn(
          { statusCode, message: err?.message, loggedOut },
          'WhatsApp connection closed',
        );

        if (this.stopping) return;

        if (loggedOut) {
          logger.error(
            'WhatsApp session was logged out from the phone. Delete the auth ' +
              'directory and restart to re-pair. Not reconnecting.',
          );
          return;
        }

        // Bounded exponential backoff, jittered.
        this.reconnectAttempt += 1;
        const delay = Math.min(
          RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt - 1, 5),
          RECONNECT_MAX_MS,
        );
        const jittered = delay + Math.floor(Math.random() * 1000);
        logger.info({ attempt: this.reconnectAttempt, delayMs: jittered }, 'Reconnecting');
        setTimeout(() => {
          this.connect().catch((e) => logger.error({ err: e }, 'Reconnect failed'));
        }, jittered);
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const raw of messages) {
        const normalized = this.normalize(raw);
        if (!normalized) continue;
        if (!this.onMessage) continue;
        try {
          await this.onMessage(normalized);
        } catch (err) {
          logger.error({ err }, 'Inbound dispatch failed');
        }
      }
    });
  }

  /**
   * Translate a Baileys WAMessage into the transport-agnostic NormalizedMessage.
   * Returns null for messages we should skip (from self, status broadcasts,
   * groups, non-text content for now).
   */
  private normalize(raw: WAMessage): NormalizedMessage | null {
    if (!raw.message) return null;
    if (raw.key.fromMe) return null;
    if (!raw.key.remoteJid) return null;
    if (raw.key.remoteJid === 'status@broadcast') return null;
    // Skip groups for Session 1 — only direct 1:1 chats.
    if (raw.key.remoteJid.endsWith('@g.us')) return null;

    // Diagnostic: log compact key info on every inbound, plus a one-time
    // full dump of the raw message structure so we can identify which field
    // carries the real phone number for @lid senders.
    logger.info(
      {
        keyFields: Object.keys(raw.key),
        topLevelFields: Object.keys(raw),
        remoteJid: raw.key.remoteJid,
        participant: raw.key.participant,
        pushName: raw.pushName,
      },
      'DIAG: inbound key snapshot',
    );
    if (this.rawDumpRemaining > 0) {
      this.rawDumpRemaining -= 1;
      // JSON-stringify so nested fields survive Pino's serializer.
      logger.info(
        { rawJson: JSON.stringify(raw, (_k, v) =>
          v instanceof Uint8Array ? `<Buffer:${v.length}>` : v) },
        'DIAG: first raw inbound message (full dump)',
      );
    }

    // WhatsApp's "LID" system: in newer protocol versions, some users come
    // through with remoteJid ending in @lid (an opaque local identifier),
    // and the actual phone number lives in a separate field. If we naively
    // split off @lid and treat the prefix as a phone number, the whitelist
    // lookup will always miss for these users.
    //
    // Also: even when remoteJid ends in @s.whatsapp.net, the bare value can
    // sometimes be a LID-style 13+ digit number (not a real phone), so we
    // try to resolve the real phone for those too.
    let bare: string;
    const isLid = raw.key.remoteJid.endsWith('@lid');
    const initialBare = raw.key.remoteJid.split('@')[0];
    const looksLikeLid = initialBare.length > 12; // real phones are <=12 digits in E.164

    if (isLid || looksLikeLid) {
      const key = raw.key as Record<string, unknown>;
      const top = raw as unknown as Record<string, unknown>;
      const candidates: ReadonlyArray<readonly [string, unknown]> = [
        ['key.senderPn', key.senderPn],
        ['key.participantPn', key.participantPn],
        ['key.participant', key.participant],
        ['key.remoteJidAlt', key.remoteJidAlt],
        ['key.participantAlt', key.participantAlt],
        ['senderPn', top.senderPn],
        ['participantPn', top.participantPn],
        ['verifiedBizName', top.verifiedBizName],
      ];
      let resolved: { name: string; jid: string } | null = null;
      for (const [name, val] of candidates) {
        if (typeof val === 'string' && val.endsWith('@s.whatsapp.net')) {
          const candidateBare = val.split('@')[0];
          // Reject if it looks like another LID
          if (candidateBare.length <= 12) {
            resolved = { name, jid: val };
            break;
          }
        }
      }
      if (!resolved) {
        // Dump everything we have so we can identify the right field.
        logger.warn(
          {
            remoteJid: raw.key.remoteJid,
            keyDump: raw.key,
            topLevelKeys: Object.keys(raw),
            msgId: raw.key.id,
            pushName: raw.pushName,
          },
          'Inbound LID/long-id message: cannot resolve real phone number — skipping. Paste this log line to the dev.',
        );
        return null;
      }
      logger.debug({ from: resolved.name, jid: resolved.jid }, 'Resolved LID → phone number');
      bare = resolved.jid.split('@')[0];
    } else {
      bare = initialBare;
    }

    // Extract text. Baileys can deliver text in several block types; cover the
    // common ones. Anything else (images, audio, stickers) is out of scope for
    // Session 1 — we just ignore them.
    const m = raw.message;
    const text =
      m.conversation ??
      m.extendedTextMessage?.text ??
      m.imageMessage?.caption ??
      m.videoMessage?.caption ??
      null;

    if (!text || text.trim().length === 0) return null;

    const phoneNumber = `+${bare}`;

    return {
      phoneNumber,
      channel: 'whatsapp',
      content: text,
      receivedAt: raw.messageTimestamp
        ? new Date(Number(raw.messageTimestamp) * 1000)
        : new Date(),
      externalId: raw.key.id ?? undefined,
    };
  }

  async send(reply: OutboundReply): Promise<void> {
    if (!this.sock) {
      throw new Error('WhatsApp adapter not connected');
    }
    // E.164 (+15551234567) → Baileys JID (15551234567@s.whatsapp.net).
    const bare = reply.phoneNumber.replace(/^\+/, '');
    const jid = `${bare}@s.whatsapp.net`;
    await this.sock.sendMessage(jid, { text: reply.content });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sock) {
      try {
        await this.sock.logout('shutdown').catch(() => {
          /* ignore — we tried */
        });
      } catch {
        /* ignore */
      }
      this.sock.end(undefined);
      this.sock = null;
    }
  }
}
