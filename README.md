# 🎬 Telegram File Deliver Bot

A Telegram bot that indexes files from a private storage channel and lets users search and download them. It has fuzzy search, daily limits, favorites, group support and admin tools. It is built with Node.js and MongoDB, runs in webhook mode, and is designed for Render's free tier.

## ✨ Features

- **Search**: exact keyword match first, then a prefix-based fuzzy fallback. Results are paginated and only the user who searched can page them.
- **Daily limits**: atomic per-user counter, refunded if delivery fails, resets at midnight UTC.
- **Favorites, Trending (weekly, resets Monday UTC) and Recent.**
- **Force join**: optionally require users to join a channel (fails closed during Telegram outages).
- **Groups**: search by typing. Results open a private DM with the file, so files are never posted publicly.
- **Auto-delete**: delivered files, results and group replies are removed after a configurable delay.
- **Admin tools**: stats, broadcast, ban/unban and file removal, all through `/admin`.
- **Auto-indexing**: videos and documents posted to the storage channel get sequential IDs (`F0001`, `F0002`, …) and a `✅ Indexed` caption.
- **Resilience**: retries on network/429/5xx errors, IPv4-first networking, graceful shutdown, secure webhook (secret path plus timing-safe header check).

## 🚀 Deploy on Render

**Prerequisites**
- A [Render](https://render.com) account
- A [MongoDB Atlas](https://www.mongodb.com/atlas) database (the free tier works)
- A bot token from [@BotFather](https://t.me/BotFather)
- A **private** Telegram channel for storage, with the bot added as **Administrator** (post, edit and delete permissions). Get its ID by forwarding a message from it to [@userinfobot](https://t.me/userinfobot).
- *(Optional)* A channel for force join, with the bot added as Administrator

**Steps**
1. Push the repo to GitHub. `package.json` must contain `"type": "module"`, a `"start": "node bot.js"` script, and the dependencies `dotenv`, `node-telegram-bot-api`, `mongoose` and `express`.
2. In Render, go to **New → Web Service** and connect the repo.
3. Set **Build Command** to `npm install` and **Start Command** to `npm start`.
4. Under **Environment**, add `NODE_VERSION=22` and the variables from the table below.
5. Deploy once to get your app URL, set `RENDER_EXTERNAL_URL` to it (HTTPS, no trailing slash), then redeploy. The webhook registers automatically on startup.

In MongoDB Atlas, allow Render's connection under **Network Access** (`0.0.0.0/0` is the simplest option for the free tier).

## ⚙️ Environment Variables

If a required value is missing or invalid, the bot exits at startup and lists what is wrong.

**Required**

| Variable | Description |
|---|---|
| `TELEGRAM_TOKEN` | Bot token from BotFather |
| `MONGODB_URI` | `mongodb://` or `mongodb+srv://` connection string |
| `STORAGE_CHANNEL_ID` | Numeric ID of the storage channel (e.g. `-1001234567890`) |
| `RENDER_EXTERNAL_URL` | Public HTTPS URL of your app |

**Optional**

| Variable | Default | Description |
|---|---|---|
| `ADMIN_IDS` | none | Comma-separated numeric user IDs of admins |
| `FORCE_CHANNEL_ID` | disabled | `@username` or numeric ID of the channel users must join |
| `FORCE_CHANNEL_LINK` | auto | Permanent `https://t.me/...` invite link (recommended for private channels) |
| `WEBHOOK_SECRET` | derived from token | 16–256 chars of `A-Z a-z 0-9 _ -` |
| `DAILY_LIMIT` | `100` | Downloads per user per day |
| `RESULTS_PER_PAGE` | `10` | Results per page (1–50) |
| `FAV_LIMIT` | `50` | Max favorites per user |
| `TRENDING_LIMIT` / `RECENT_LIMIT` | `10` | Items in `/trending` and `/recent` |
| `FUZZY_MIN_WORD_LEN` | `3` | Minimum word length for fuzzy matching |
| `LIMIT_DOC_TTL_DAYS` | `2` | Days before daily-limit records are purged |
| `PRIVATE_AUTO_DELETE_MS` | `60000` | Delete delay for delivered files and results |
| `GROUP_AUTO_DELETE_MS` | `60000` | Delete delay for group replies |
| `NO_RESULT_DELETE_MS` | `60000` | Delete delay for "no results" messages |
| `GROUP_COOLDOWN_MS` | `2000` | Minimum gap between replies per group (`0` disables) |
| `PORT` | `3000` | HTTP port (Render sets this automatically) |

Delete delays can be at most 48 hours (`172800000`), because Telegram cannot delete older messages.

## 🏃 Run Locally

```bash
git clone https://github.com/Aman-20/telegram-file-deliver-bot.git
cd telegram-file-deliver-bot
npm install
cp .env.example .env   # fill in your values
node bot.js
```

The bot uses webhooks, so locally you need a public HTTPS URL. Run `ngrok http 3000` and set `RENDER_EXTERNAL_URL` to the ngrok URL.

## 📋 Commands

**Users**

| Command | Description |
|---|---|
| `/start` | Welcome message (also handles `?start=F0001` file links) |
| `/help` | Command guide |
| `/trending` | Most downloaded files this week |
| `/recent` | Latest uploads |
| `/favorites` | Your saved files (private chat) |
| `/clearfavorites` | Remove all favorites (private chat) |
| `/myaccount` | Your daily download usage (private chat) |

To search, just type a name (at least 3 characters), in private chat or in a group.

**Admins** (listed by `/admin`, silently ignored for everyone else)

| Command | Description |
|---|---|
| `/admin` | Show the admin command list |
| `/stats` | Users, banned users and file counts |
| `/broadcast <message>` | Send an HTML-formatted message to all active users |
| `/broadcast` (reply to a message) | Copy any message (media, forwards, etc.) to all active users |
| `/cancel` | Stop a running broadcast |
| `/delete <FILE_ID>` | Remove a file from the index, favorites and the storage channel (e.g. `/delete F0001`) |
| `/ban <userId>` / `/unban <userId>` | Ban or unban a user (admins can't be banned) |

## ⚠️ Notes

- The bot must be an admin in the storage channel (to index and edit captions) and in the force-join channel (to verify membership). If it isn't an admin in the force-join channel, users are let through instead of blocked.
- Files are delivered with `copyMessage`, so users never see the storage channel.
- `/delete` also deletes the post from the storage channel, so the bot needs the **Delete messages** admin permission there. If Telegram refuses (for example on very old posts), the bot tells you to delete the post manually.
- Users who block the bot are marked inactive and skipped by broadcasts.
- Auto-delete timers are kept in memory, so a restart or redeploy cancels pending deletions.

## 🩺 Troubleshooting

| Problem | Likely cause |
|---|---|
| `❌ Invalid configuration` at startup | A required variable is missing or malformed; the log lists which |
| Files aren't indexed | Bot isn't an admin in the storage channel, or `STORAGE_CHANNEL_ID` is wrong |
| Bot doesn't respond | `RENDER_EXTERNAL_URL` is wrong or not HTTPS, or webhook registration failed (check logs) |
| "Could not verify channel membership" | Temporary Telegram or network issue; users can retry |
| Join button missing | Set `FORCE_CHANNEL_LINK`, or make the bot an admin in the force-join channel |
| MongoDB connection fails | Atlas Network Access doesn't allow Render's IPs |

## 📄 License

MIT. Made with ❤️ by Aman.
