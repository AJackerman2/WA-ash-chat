#!/usr/bin/env bash
#
# First-time deploy to the Hetzner CX22 box for ASH-ai chat bot.
#
# Usage on the box (as root):
#   curl -fsSL https://raw.githubusercontent.com/AJackerman2/WA-ash-chat/claude/setup-whatsapp-bot-00mBU/scripts/deploy-hetzner.sh | DATABASE_URL='...' ANTHROPIC_API_KEY='...' bash
#
# Or copy this file up and:
#   DATABASE_URL='...' ANTHROPIC_API_KEY='...' bash deploy-hetzner.sh
#
# After this script finishes, run `pm2 logs wa-ash-chat`, scan the printed QR
# code with the bot's WhatsApp, and the bot is live.

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" || -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Set DATABASE_URL and ANTHROPIC_API_KEY in the environment before running."
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/wa-ash-chat}"
GIT_BRANCH="${GIT_BRANCH:-claude/setup-whatsapp-bot-00mBU}"
REPO_URL="${REPO_URL:-https://github.com/AJackerman2/WA-ash-chat.git}"

echo "==> Installing Node 20 + tooling"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs git build-essential
fi
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

echo "==> Cloning / updating repo"
mkdir -p "$(dirname "$APP_DIR")"
if [[ -d "$APP_DIR/.git" ]]; then
  cd "$APP_DIR"
  git fetch origin
  git checkout "$GIT_BRANCH"
  git pull origin "$GIT_BRANCH"
else
  git clone --branch "$GIT_BRANCH" "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> Writing .env"
umask 077
cat > .env <<EOF
DATABASE_URL=$DATABASE_URL
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
NODE_ENV=production
LOG_LEVEL=info
AUTH_DIR=$APP_DIR/auth
ANTHROPIC_MODEL=claude-sonnet-4-6
CONTEXT_WINDOW_SIZE=20
MAX_OUTPUT_TOKENS=1024
BOT_NAME=ASH-ai
EOF
umask 022

echo "==> Installing dependencies"
npm ci

echo "==> Building"
npm run build

echo "==> Running migrations"
npm run db:migrate

echo "==> Whitelisting testers"
npm run whitelist -- add +19179240018 || true
npm run whitelist -- add +972553377952 || true
npm run whitelist -- add +19293555631 || true

echo "==> Starting under PM2"
mkdir -p logs
pm2 delete wa-ash-chat 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo ""
echo "Deployed."
echo ""
echo "Next steps:"
echo "  1. Run:  pm2 logs wa-ash-chat"
echo "  2. Scan the QR code from WhatsApp on the bot phone:"
echo "     Settings → Linked Devices → Link a Device → scan"
echo "  3. Send a message from a whitelisted number and confirm a reply."
echo "  4. To make PM2 survive reboots:  pm2 startup  (and follow its prompt)"
