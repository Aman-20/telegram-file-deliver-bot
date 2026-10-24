# 🎬 Telegram File Deliver Bot

A production-ready Telegram bot that indexes files from a private storage channel and lets users search and download them — with fuzzy search, daily limits, favorites, group support, and admin tools. Built with Node.js, MongoDB, and deployed on Render.

---

## ✨ Features

- **Search** — Two-stage search: exact keyword match (all words must match) → prefix fuzzy fallback.
- **Pagination** — Results are paged with Prev/Next buttons; only the user who searched can page their results.
- **Force Join** — Require users to join a channel before using the bot (fails closed during Telegram outages).
- **Daily Limits** — Per-user download limit with atomic counting; automatically refunded if delivery fails. Resets at midnight UTC.
- **Favorites** — Save up to 50 files (configurable), view and clear them anytime.
- **Trending & Recent** — Trending is based on **weekly** downloads and resets every Monday (UTC).
- **Auto-Delete** — Delivered files, results, and group replies are deleted after a configurable delay.
- **Broadcast** — Admins can send text or copy any message to all active users, with cancel support.
- **Ban / Unban** — Admins can block users from using the bot.
- **Resilience** — Retries on transient network/429/5xx errors, IPv4-first networking, graceful shutdown, and in-memory TTL caches (bans, membership, search results, cooldowns).
- **Secure webhook** — Secret path plus Telegram's secret-token header validated with a timing-safe comparison.
- **Keep-alive** — Self-ping every 14 minutes to keep Render's free tier awake.

### For Groups
- Members can search by typing in the group chat
- Results show buttons that open a **private DM** with the file — files are never posted publicly
- Per-group cooldown to prevent spam; replies auto-delete

### For Admins
- Manage users and files with the commands listed below
- Admins bypass the force-join check

### Indexing
- Files (`video` or `document`) posted to the storage channel are **indexed automatically**
- Each file gets a sequential ID (`F0001`, `F0002`, …)
- The channel post's caption is updated with `✅ Indexed: F0001`
- Indexing is idempotent — redelivered updates never create duplicates
- Titles are cleaned (extension, `@handles`, and punctuation removed) and split into searchable keywords

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ (ESM, `type: "module"`, top-level `await`) |
| Telegram | `node-telegram-bot-api` (webhook mode) |
| Database | MongoDB via Mongoose |
| Server | Express.js |
| Config | `dotenv` |
| Hosting | Render (Web Service) |

---

## 📁 Project Structure

```
.
├── bot.js            # Main bot file (single-file architecture)
├── .env              # Your environment variables (not committed)
├── .env.example      # Template for .env
├── package.json
└── README.md
```

---

## ⚙️ Environment Variables

Copy `.env.example` to `.env` and fill it in. Invalid or missing **required** values make the bot exit at startup with a clear error list.

### Required

| Variable | Description |
|---|---|
| `TELEGRAM_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `MONGODB_URI` | MongoDB connection string (`mongodb://` or `mongodb+srv://`) |
| `STORAGE_CHANNEL_ID` | Numeric ID of the storage channel (e.g. `-1001234567890`) |
| `RENDER_EXTERNAL_URL` | Public **HTTPS** URL of your app (e.g. `https://your-app.onrender.com`) |

### Admins & Force Join

| Variable | Default | Description |
|---|---|---|
| `ADMIN_IDS` | *(empty)* | Comma-separated numeric Telegram user IDs with admin access |
| `FORCE_CHANNEL_ID` | *(disabled)* | `@username` or numeric ID of the channel users must join. Leave empty to disable force join |
| `FORCE_CHANNEL_LINK` | *(auto)* | Permanent `https://t.me/...` invite link for the Join button. Recommended for private/numeric channels |

### Security

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_SECRET` | *(derived from token)* | 16–256 chars of `A-Z a-z 0-9 _ -`. Used in the webhook path and secret-token header |

### Limits & Pagination

| Variable | Default | Range | Description |
|---|---|---|---|
| `DAILY_LIMIT` | `100` | 1–100000 | Downloads per user per day |
| `RESULTS_PER_PAGE` | `10` | 1–50 | Results per page |
| `FAV_LIMIT` | `50` | 1–1000 | Max favorites per user |
| `TRENDING_LIMIT` | `10` | 1–50 | Items in `/trending` |
| `RECENT_LIMIT` | `10` | 1–50 | Items in `/recent` |
| `FUZZY_MIN_WORD_LEN` | `3` | 1–20 | Min word length for fuzzy prefix matching |
| `LIMIT_DOC_TTL_DAYS` | `2` | 1–365 | Days before daily-limit records are purged |

### Auto-Delete & Cooldowns (milliseconds)

| Variable | Default | Range | Description |
|---|---|---|---|
| `PRIVATE_AUTO_DELETE_MS` | `60000` | 1000–172800000 | Delay before delivered files/results are deleted |
| `GROUP_AUTO_DELETE_MS` | `60000` | 1000–172800000 | Delay before group replies are deleted |
| `NO_RESULT_DELETE_MS` | `60000` | 1000–172800000 | Delay before "no results" messages are deleted |
| `GROUP_COOLDOWN_MS` | `2000` | 0–3600000 | Minimum gap between bot responses per group (`0` disables) |

> Telegram can't delete messages older than 48 hours, hence the upper bound.

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port (Render sets this automatically) |

---

## 🚀 Deployment on Render

### 1. Prerequisites
- A [Render](https://render.com) account
- A MongoDB database (e.g. [MongoDB Atlas](https://www.mongodb.com/atlas) free tier)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A **private** Telegram channel for file storage where the bot is an admin

### 2. Set Up the Storage Channel
1. Create a private Telegram channel
2. Add your bot as an **Administrator** with permission to post and edit messages
3. Get the channel ID by forwarding a message from it to [@userinfobot](https://t.me/userinfobot)

### 3. (Optional) Set Up Force Join
1. Add the bot as an **Administrator** in the channel users must join
2. Set `FORCE_CHANNEL_ID` (and ideally `FORCE_CHANNEL_LINK` if the channel is private)

### 4. Deploy to Render
1. Push this repo to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com) → **New Web Service**
3. Connect your GitHub repo
4. Configure the service:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Add the environment variables from the tables above under **Environment**
6. Set `RENDER_EXTERNAL_URL` to your Render app's URL (visible after the first deploy), then redeploy
7. Click **Deploy** — the bot registers its webhook automatically on startup

---

## 🏃 Running Locally

```bash
# 1. Clone the repo
git clone https://github.com/Aman-20/telegram-file-deliver-bot.git
cd telegram-file-deliver-bot

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Edit .env with your values

# 4. Run the bot
node bot.js
```

> **Note:** The bot uses webhooks, so local mode needs a public HTTPS URL. Use a tunneling tool like [ngrok](https://ngrok.com) (`ngrok http 3000`) and set `RENDER_EXTERNAL_URL` to the ngrok URL.

---

## 📋 User Commands

| Command | Description |
|---|---|
| `/start` | Welcome message / re-authenticate (also handles `?start=F0001` file deep links) |
| `/help` | Full command guide |
| `/trending` | Most downloaded files this week |
| `/recent` | Latest uploaded files |
| `/favorites` | Your saved files (private chat only) |
| `/clearfavorites` | Remove all your saved favorites (private chat only) |
| `/myaccount` | Check your daily download usage (private chat only) |

To search, just send a file/movie/show name (minimum 3 characters) — in private chat or in a group.

## 🔐 Admin Commands

| Command | Description |
|---|---|
| `/stats` | Bot statistics (users, banned users, files) |
| `/broadcast <message>` | Send an HTML-formatted message to all active users |
| `/broadcast` *(reply to a message)* | Copy any message (media, forwards, etc.) to all active users |
| `/cancel` | Stop a running broadcast |
| `/delete <FILE_ID>` | Remove a file from the index (e.g. `/delete F0001`) and from users' favorites |
| `/ban <userId>` | Ban a user from the bot (admins can't be banned) |
| `/unban <userId>` | Unban a user |

---

## ⚠️ Important Notes

- The bot must be an **admin** in the storage channel to index files and edit captions.
- If `FORCE_CHANNEL_ID` is set, the bot must also be an **admin** in that channel to verify membership. If it isn't, users are let through rather than blocked.
- Daily limits reset at **midnight UTC**; trending resets every **Monday (UTC)**.
- Files are delivered with `copyMessage` from the storage channel, so users never see the channel.
- `/delete` removes a file from the index only — the original post stays in the storage channel.
- File IDs are sequential in the format `F0001`, `F0002`, etc.
- Users who block the bot are marked inactive and skipped by future broadcasts.
- Multiple files with the same `message_id` can't be indexed; if your collection already has duplicates, the unique index build will log an error (check logs).

---

## 🩺 Troubleshooting

| Problem | Likely cause |
|---|---|
| Bot exits with `❌ Invalid configuration` | A required env var is missing or malformed — the message lists exactly which |
| Files in the channel aren't indexed | Bot isn't an admin in the storage channel, or `STORAGE_CHANNEL_ID` is wrong |
| Bot doesn't respond | Wrong `RENDER_EXTERNAL_URL` (must be HTTPS) or webhook registration failed — check logs |
| "Could not verify channel membership" | Temporary Telegram/network issue; users can retry |
| Join button missing | Set `FORCE_CHANNEL_LINK`, or make the bot admin in the force-join channel |

---

## 📄 License

MIT — feel free to use, modify, and distribute.

---

**Made with ❤️ by Aman**
