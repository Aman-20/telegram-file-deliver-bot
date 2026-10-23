# 🎬 Telegram File Search Bot

A production-ready Telegram bot that indexes files from a private storage channel and lets users search and download them — with fuzzy search, daily limits, favorites, group support, and admin tools. Built with Node.js, MongoDB, and deployed on Render.

---

## Features
 
- **Search** — Two-stage search: exact keyword match → prefix fuzzy fallback
- **Force Join** — Require users to join a channel before using the bot
- **Daily Limits** — Per-user download limits, auto-reset at midnight UTC
- **Favorites** — Users can save up to 50 files
- **Trending & Recent** — Browse popular and newly added files
- **Auto-Delete** — Files sent in groups/private auto-delete after a configurable delay
- **Broadcast** — Admins can message all registered users
- **Ban/Unban** — Admins can block users from using the bot
- **In-memory caching** — TTL caches for member checks, search results, and cooldowns

### For Groups
- Group members can search directly in the chat
- Results send a private DM link — files are never posted publicly
- Per-group cooldown to prevent spam

### For Admins
- 📊 `/stats` — Total users, files, and banned count
- 📢 `/broadcast` — Send a message or forward any content to all users
- 🗑️ `/delete [ID]` — Remove a file from the index
- 🚫 `/ban [userId]` — Ban a user
- ✅ `/unban [userId]` — Unban a user

### Indexing
- Files posted to the storage channel are **automatically indexed**
- Caption is updated with the assigned file ID after indexing
- Supports `video` and `document` type files

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM, `type: "module"`) |
| Telegram | `node-telegram-bot-api` (webhook mode) |
| Database | MongoDB via Mongoose |
| Server | Express.js |
| Hosting | Render (Web Service) |

---

## 📁 Project Structure

```
.
├── bot.js          # Main bot file (single-file architecture)
├── .env            # Environment variables
├── package.json
└── README.md
```

---

## ⚙️ Environment Variables

Create a `.env` file in the root directory. All variables marked **required** must be set or the bot will refuse to start.

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_TOKEN` | ✅ | — | Bot token from [@BotFather](https://t.me/BotFather) |
| `MONGODB_URI` | ✅ | — | MongoDB connection string |
| `STORAGE_CHANNEL_ID` | ✅ | — | Channel ID where files are stored (e.g. `-100xxxxxxxxxx`) |
| `RENDER_EXTERNAL_URL` | ✅ | — | Your Render app URL (e.g. `https://your-app.onrender.com`) |
| `ADMIN_IDS` | ✅ | `''` | Comma-separated Telegram user IDs with admin access |
| `FORCE_CHANNEL_ID` | ⚠️ | — | Channel ID or `@username` users must join before using the bot |

---

## 🚀 Deployment on Render

### 1. Prerequisites
- A [Render](https://render.com) account
- A MongoDB database (e.g. [MongoDB Atlas](https://www.mongodb.com/atlas) free tier)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A **private** Telegram channel for file storage where the bot is an admin

### 2. Setup the Storage Channel
1. Create a private Telegram channel
2. Add your bot as an **Administrator** with permission to post messages and edit messages
3. Get the channel ID by forwarding a message from it to [@userinfobot](https://t.me/userinfobot)

### 3. Deploy to Render
1. Push this repo to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com) → **New Web Service**
3. Connect your GitHub repo
4. Configure the service:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Add all environment variables from the table above under **Environment**
6. Set `RENDER_EXTERNAL_URL` to your Render app's URL (visible after first deploy)
7. Click **Deploy**

---

## 🏃 Running Locally

```bash
# 1. Clone the repo
git clone https://github.com/Aman-20/TelegramFileDeliverBot.git
cd your-repo

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Edit .env with your values

# 4. Run the bot
node bot.js
```

> **Note:** Local mode requires a public webhook URL. Use a tunneling tool like [ngrok](https://ngrok.com) and set `RENDER_EXTERNAL_URL` to your ngrok URL.

---

## 📋 User Commands

| Command | Description |
|---|---|
| `/start` | Welcome message / re-authenticate |
| `/help` | Full command guide |
| `/trending` | Most downloaded files |
| `/recent` | Latest uploaded files |
| `/favorites` | Your saved files |
| `/myaccount` | Check your daily download usage |

## 🔐 Admin Commands

| Command | Description |
|---|---|
| `/stats` | Bot statistics (users, files, banned) |
| `/broadcast <message>` | Send a message to all users |
| `/broadcast` *(reply to msg)* | Forward any message to all users |
| `/delete <FILE_ID>` | Remove a file from the index |
| `/ban <userId>` | Ban a user from the bot |
| `/unban <userId>` | Unban a user |

---

## ⚠️ Important Notes

- The bot must be an **admin** in the storage channel to index files and generate invite links.
- If `FORCE_CHANNEL_ID` is set, the bot must also be an admin in that channel to verify membership.
- Daily limits reset at **midnight UTC**.
- File IDs are sequential in format `F0001`, `F0002`, etc.

---

## 📄 License

MIT — feel free to use, modify, and distribute.

---

**Made with ❤️ by Aman**
