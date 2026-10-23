import dotenv from 'dotenv';
dotenv.config();

import TelegramBot from 'node-telegram-bot-api';
import mongoose from 'mongoose';
import express from 'express';

// ============================================================
// --- GLOBAL ERROR HANDLERS ---
// ============================================================
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

// ============================================================
// --- CONFIGURATION ---
// ============================================================
const {
  TELEGRAM_TOKEN,
  MONGODB_URI,
  ADMIN_IDS = '',
  DAILY_LIMIT = '100',
  RESULTS_PER_PAGE = '10',
  PORT = '3000',
  RENDER_EXTERNAL_URL,
  FORCE_CHANNEL_ID,
  STORAGE_CHANNEL_ID,
  FAV_LIMIT = '50',
  PRIVATE_AUTO_DELETE_MS = '60000',
  GROUP_AUTO_DELETE_MS = '60000',
  GROUP_COOLDOWN_MS = '2000',
  NO_RESULT_DELETE_MS = '60000',
  TRENDING_LIMIT = '10',
  RECENT_LIMIT = '10',
  FUZZY_MIN_WORD_LEN = '3',
  LIMIT_DOC_TTL_DAYS = '2',
} = process.env;

if (!TELEGRAM_TOKEN || !MONGODB_URI || !STORAGE_CHANNEL_ID || !RENDER_EXTERNAL_URL) {
  console.error('❌ Error: Missing required env vars: TELEGRAM_TOKEN, MONGODB_URI, STORAGE_CHANNEL_ID, RENDER_EXTERNAL_URL');
  process.exit(1);
}

const ADMIN_SET               = new Set(ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean));
const STORAGE_CHANNEL_ID_STR  = String(STORAGE_CHANNEL_ID);
const DAILY_LIMIT_NUM         = Number(DAILY_LIMIT);
const RESULTS_PER_PAGE_NUM    = Number(RESULTS_PER_PAGE);
const FAV_LIMIT_NUM           = Number(FAV_LIMIT);
const PRIVATE_DELETE_TIME     = Number(PRIVATE_AUTO_DELETE_MS);
const GROUP_DELETE_TIME       = Number(GROUP_AUTO_DELETE_MS);
const GROUP_COOLDOWN_TIME     = Number(GROUP_COOLDOWN_MS);
const NO_RESULT_DELETE_TIME   = Number(NO_RESULT_DELETE_MS);
const TRENDING_LIMIT_NUM      = Number(TRENDING_LIMIT);
const RECENT_LIMIT_NUM        = Number(RECENT_LIMIT);
const FUZZY_MIN_LEN           = Number(FUZZY_MIN_WORD_LEN);

// ============================================================
// --- IN-MEMORY CACHES (replaces MongoDB temp collections) ---
// ============================================================

// Generic TTL cache entry: { value, expiresAt }
class TTLCache {
  constructor(ttlMs) {
    this._map = new Map();
    this._ttl = ttlMs;
    // Periodic sweep to avoid unbounded memory growth (~every 5 min)
    setInterval(() => this._sweep(), 5 * 60 * 1000).unref();
  }
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) { this._map.delete(key); return undefined; }
    return entry.value;
  }
  set(key, value) {
    this._map.set(key, { value, expiresAt: Date.now() + this._ttl });
  }
  delete(key) { this._map.delete(key); }
  _sweep() {
    const now = Date.now();
    for (const [k, e] of this._map) if (now > e.expiresAt) this._map.delete(k);
  }
}

// Ban cache — 5 min TTL
const banCache = new TTLCache(5 * 60 * 1000);

// Member join cache — 15 min TTL
const memberCache = new TTLCache(15 * 60 * 1000);

// Group cooldown — 2 s TTL (keyed by chatId)
const groupCooldownCache = new TTLCache(GROUP_COOLDOWN_TIME);

// Search result cache — 5 min TTL
// key: `${userId}:${searchId}` → fileIds array
const searchResultCache = new TTLCache(5 * 60 * 1000);

// Deletion scheduler — centralized, avoids leaking timer references
const pendingDeletions = new Map(); // `${chatId}:${messageId}` → timer id

function scheduleDelete(bot, chatId, messageId, delayMs) {
  const key = `${chatId}:${messageId}`;
  if (pendingDeletions.has(key)) return; // already scheduled
  const t = setTimeout(async () => {
    pendingDeletions.delete(key);
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (e) {
      // Ignore "message not found" (400/404) — already deleted or never existed
      if (!e.message?.includes('message to delete not found') &&
          !e.message?.includes('message can\'t be deleted')) {
        console.warn('Delete error (non-fatal):', e.message);
      }
    }
  }, delayMs);
  pendingDeletions.set(key, t);
}

// ============================================================
// --- DATABASE ---
// ============================================================
try {
  await mongoose.connect(MONGODB_URI, {
    dbName: 'TelegramMovies',
    maxPoolSize: 10,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
  console.log('✅ MongoDB Connected');
} catch (err) {
  console.error('❌ MongoDB Connection Failed:', err);
  process.exit(1);
}

// ============================================================
// --- SCHEMAS (only permanent collections remain) ---
// ============================================================
const Schema = mongoose.Schema;

const UserSchema = new Schema({
  userId:    { type: String, unique: true, index: true },
  firstName: String,
  username:  String,
  joinedAt:  { type: Date, default: Date.now },
  isBanned:  { type: Boolean, default: false, index: true },
  isInactive:{ type: Boolean, default: false }
});
const User = mongoose.model('User', UserSchema);

const FileSchema = new Schema({
  customId:   { type: String, unique: true, index: true },
  message_id: { type: Number, required: true },
  file_name:  String,
  type:       String,
  file_size:  String,
  clean_title:String,
  attributes: { type: [String], index: true },
  uploaded_at:{ type: Date, default: Date.now, index: true },
  downloads:  { type: Number, default: 0, index: true },          // lifetime total (never reset)
  weeklyDownloads: { type: Number, default: 0, index: true }      // reset every Monday 00:00 UTC
});

const File = mongoose.model('File', FileSchema);

// Small key/value store (used to remember which week trending was last reset)
const SettingSchema = new Schema({ _id: String, value: String });
const Setting = mongoose.model('Setting', SettingSchema);

const CounterSchema = new Schema({ _id: String, seq: Number });
const Counter = mongoose.model('Counter', CounterSchema);

const LimitSchema = new Schema({
  userId:    String,
  date:      String,
  count:     { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: Number(LIMIT_DOC_TTL_DAYS) * 86400 }
});
LimitSchema.index({ userId: 1, date: 1 }, { unique: true });
const Limit = mongoose.model('Limit', LimitSchema);

const FavoriteSchema = new Schema({
  userId:  String,
  customId:String,
  savedAt: { type: Date, default: Date.now }
});
FavoriteSchema.index({ userId: 1, customId: 1 }, { unique: true });
const Favorite = mongoose.model('Favorite', FavoriteSchema);

// ============================================================
// --- HELPERS ---
// ============================================================

// --- WEEKLY TRENDING RESET ---
// Returns the UTC date (YYYY-MM-DD) of the Monday that starts the current week
function currentWeekKey() {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

// Safe to call repeatedly / after restarts: the week key is claimed atomically,
// so the reset runs exactly once per week even if the bot was asleep on Monday.
async function resetTrendingIfNewWeek() {
  const weekKey = currentWeekKey();
  try {
    const claimed = await Setting.findOneAndUpdate(
      { _id: 'trendingWeek', value: { $ne: weekKey } },
      { $set: { value: weekKey } },
      { upsert: true, new: true }
    ).lean();
    if (claimed) {
      const res = await File.updateMany({ weeklyDownloads: { $gt: 0 } }, { $set: { weeklyDownloads: 0 } });
      console.log(`🔄 Weekly trending reset (week of ${weekKey}), ${res.modifiedCount} files cleared`);
    }
  } catch (e) {
    // 11000 = key already equals current week (upsert collided) → nothing to do
    if (e.code !== 11000) console.error('Trending reset error:', e.message);
  }
}

await resetTrendingIfNewWeek();
setInterval(resetTrendingIfNewWeek, 60 * 60 * 1000).unref(); // check hourly

async function nextSequence(name = 'file') {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  ).lean();
  return 'F' + String(doc.seq).padStart(4, '0');
}

// Atomic check-and-increment (prevents race conditions)
async function incrementIfUnderLimit(userId) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await Limit.create({ userId, date: today, count: 1, createdAt: new Date() });
    return true;
  } catch (e) {
    if (e.code !== 11000) throw e;
    const doc = await Limit.findOneAndUpdate(
      { userId, date: today, count: { $lt: DAILY_LIMIT_NUM } },
      { $inc: { count: 1 } },
      { new: true }
    ).lean();
    return doc !== null;
  }
}

async function getUserLimitCount(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const doc = await Limit.findOne({ userId, date: today }).select('count').lean();
  return doc?.count || 0;
}

async function saveUser(msg) {
  if (!msg.from || msg.from.is_bot) return;
  const userId = String(msg.from.id);
  await User.updateOne(
    { userId },
    {
      $set: { firstName: msg.from.first_name, username: msg.from.username },
      $setOnInsert: { joinedAt: new Date(), isBanned: false, isInactive: false }
    },
    { upsert: true }
  ).catch(err => console.error('saveUser error:', err.message));
}

// --- BAN CACHE ---
async function isUserBanned(userId) {
  const cached = banCache.get(userId);
  if (cached !== undefined) return cached;
  const user = await User.findOne({ userId }, { isBanned: 1 }).lean();
  const banned = user?.isBanned === true;
  banCache.set(userId, banned);
  return banned;
}

function invalidateBanCache(userId) {
  banCache.delete(userId);
}

// --- MEMBER CACHE ---
function getMemberCache(userId) {
  return memberCache.get(userId) ?? null;
}

function setMemberCacheEntry(userId, verified) {
  memberCache.set(userId, verified);
}

function clearMemberCacheEntry(userId) {
  memberCache.delete(userId);
}

// --- GROUP COOLDOWN ---
function checkAndSetGroupCooldown(chatId) {
  const key = String(chatId);
  if (groupCooldownCache.get(key) !== undefined) return false; // still in cooldown
  groupCooldownCache.set(key, true);
  return true;
}

// --- SEARCH CACHE ---
function cacheSearchResults(userId, fileIds) {
  const searchId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  searchResultCache.set(`${userId}:${searchId}`, fileIds);
  return searchId;
}

function getCachedPage(userId, searchId, page) {
  const fileIds = searchResultCache.get(`${userId}:${searchId}`);
  if (!fileIds) return { ids: [], total: 0 };
  const total = fileIds.length;
  const start = page * RESULTS_PER_PAGE_NUM;
  const ids = fileIds.slice(start, start + RESULTS_PER_PAGE_NUM);
  return { ids, total };
}

// --- MISC HELPERS ---
function formatSearchBtn(f) {
  return `${f.file_size}  |  ${f.clean_title}`;
}

function cleanFileName(text) {
  return text
    .replace(/\.(mkv|mp4|avi|mov|flv|wmv|webm|m4v)$/i, '')
    .replace(/@\w+/g, '')
    .replace(/[\[\]\(\)\{\}\.\;\:\~\|\,\_\-\+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSize(bytes) {
  if (!bytes) return 'Unknown';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(1) + ' KB';
}

// ============================================================
// --- UNIFIED DELIVERY (all downloads go through here) ---
// ============================================================
async function deliverFile(bot, chatId, fromId, customId) {
  const file = await File.findOne({ customId })
    .select('message_id clean_title file_size type customId _id')
    .lean();
  if (!file) return bot.sendMessage(chatId, '❌ File no longer exists.');

  const allowed = await incrementIfUnderLimit(fromId);
  if (!allowed) {
    return bot.sendMessage(chatId,
      `⚠️ Daily limit of <b>${DAILY_LIMIT_NUM}</b> reached. Resets at midnight UTC.`,
      { parse_mode: 'HTML' }
    );
  }

  let sent;
  try {
    sent = await bot.copyMessage(chatId, STORAGE_CHANNEL_ID, file.message_id, {
      caption:
        `🎬 <b>${file.clean_title}</b>\n` +
        `🆔 ID: <code>${file.customId}</code>\n\n` +
        `⚠️ <i>Auto-deletes in ${PRIVATE_DELETE_TIME / 1000}s</i>`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❤️ Add to Favorites', callback_data: `FAV:${file.customId}` }]] }
    });
  } catch (err) {
    // Refund the limit count so the user isn't penalised for a Telegram-side failure
    const today = new Date().toISOString().slice(0, 10);
    Limit.findOneAndUpdate({ userId: fromId, date: today }, { $inc: { count: -1 } }).catch(() => {});
    console.error('copyMessage failed in deliverFile:', err.message);
    return bot.sendMessage(chatId, '⚠️ Could not send the file. Please try again.').catch(() => {});
  }

  // Increment download count only after successful delivery
  await File.updateOne({ _id: file._id }, { $inc: { downloads: 1, weeklyDownloads: 1 } });
  scheduleDelete(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
}

// ============================================================
// --- SEARCH ---
// ============================================================
async function searchFiles(query, limit = 100) {
  if (query.length > 100) return { files: [], isFuzzy: false };

  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

  // Exact keyword match
  const exact = await File.find({ attributes: { $all: keywords } })
    .select('customId clean_title file_size uploaded_at')
    .sort({ uploaded_at: -1 })
    .limit(limit)
    .lean();

  if (exact.length) return { files: exact, isFuzzy: false };

  // Fuzzy fallback — partial regex per meaningful word
  const fuzzyWords = keywords.filter(w => w.length >= FUZZY_MIN_LEN);
  if (!fuzzyWords.length) return { files: [], isFuzzy: false };

  const regexConditions = fuzzyWords.map(w => ({
    attributes: { $regex: '^' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
  }));

  const fuzzy = await File.find({ $or: regexConditions })
    .select('customId clean_title file_size uploaded_at')
    .sort({ uploaded_at: -1 })
    .limit(limit)
    .lean();

  return { files: fuzzy, isFuzzy: true };
}

// ============================================================
// --- FORCE JOIN ---
// ============================================================
async function verifyJoin(bot, chatId, userId, fileCode = null) {
  if (!FORCE_CHANNEL_ID) return true;
  if (ADMIN_SET.has(userId)) return true;

  const cached = getMemberCache(userId);
  if (cached === true) return true;

  try {
    const member = await bot.getChatMember(FORCE_CHANNEL_ID, userId);
    const isMember = ['creator', 'administrator', 'member'].includes(member.status);

    if (isMember) {
      setMemberCacheEntry(userId, true);
      return true;
    }

    let channelLink = `https://t.me/${FORCE_CHANNEL_ID}`;
    if (FORCE_CHANNEL_ID.startsWith('@')) {
      channelLink = `https://t.me/${FORCE_CHANNEL_ID.replace('@', '')}`;
    } else {
      try { channelLink = await bot.exportChatInviteLink(FORCE_CHANNEL_ID); } catch (_) {}
    }

    const callbackData = fileCode ? `CHECK_JOIN:${fileCode}` : 'CHECK_JOIN';
    await bot.sendMessage(chatId, '⚠️ <b>You must join our channel to use this bot.</b>', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📢 Join Channel', url: channelLink }],
          [{ text: '✅ I Have Joined', callback_data: callbackData }]
        ]
      }
    });
    return false;
  } catch (err) {
    console.error('Force Join Error:', err.message);
    return true; // If bot can't check (not admin), let user through
  }
}

// ============================================================
// --- SERVER + BOT SETUP ---
// ============================================================
const app = express();
app.use(express.json());

const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${RENDER_EXTERNAL_URL}/bot${TELEGRAM_TOKEN}`);

const BOT_ME = await bot.getMe();
const BOT_USERNAME = BOT_ME.username;
console.log(`✅ Bot @${BOT_USERNAME} ready`);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (_, res) => res.send('Bot is running. 🚀'));
app.listen(Number(PORT), () => console.log(`✅ Server on port ${PORT}`));

// ============================================================
// --- SELF-PING (Keep Render free tier awake) ---
// ============================================================
async function selfPing() {
  try {
    const res = await fetch(RENDER_EXTERNAL_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Connection': 'keep-alive',
      }
    });
    //console.log(`🏓 Self-ping [${res.status}]`);
    if (!res.ok) console.warn(`⚠️ Self-ping unexpected status: ${res.status}`);
  } catch (err) {
    console.warn(`⚠️ Self-ping failed: ${err.message}`);
  }
}
setInterval(selfPing, 14 * 60 * 1000);
setTimeout(selfPing, 5000);

// ============================================================
// --- COMMAND MENU ---
// ============================================================
bot.setMyCommands([
  { command: 'start',      description: '🔄 Restart Bot' },
  { command: 'recent',     description: '🆕 New Uploads' },
  { command: 'trending',   description: '🔥 Popular Files' },
  { command: 'favorites',  description: '❤️ My Saved Files' },
  { command: 'myaccount',  description: '👤 Check Limit' },
  { command: 'help',       description: '📖 Help & Commands' },
]).catch(() => {});

// ============================================================
// --- INDEXING (Storage Channel Posts) ---
// ============================================================
bot.on('channel_post', async (msg) => {
  if (String(msg.chat.id) !== STORAGE_CHANNEL_ID_STR) return;
  const file = msg.video || msg.document;
  if (!file) return;

  try {
    const rawName  = msg.caption || file.file_name || 'Unknown';
    const clean    = cleanFileName(rawName);
    const customId = await nextSequence();

    await File.create({
      customId,
      message_id:  msg.message_id,
      file_name:   rawName,
      type:        msg.video ? 'video' : 'document',
      file_size:   formatSize(file.file_size),
      clean_title: clean,
      attributes:  clean.toLowerCase().split(/\s+/).filter(t => t.length > 0)
    });

    await bot.editMessageCaption(
      `${msg.caption || ''}\n\n✅ <b>Indexed:</b> ${customId}`,
      { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML' }
    ).catch(() => {});

  } catch (err) {
    console.error('Index Error:', err);
  }
});

// ============================================================
// --- COMMANDS ---
// ============================================================

// 1. /start
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
  const chatId    = msg.chat.id;
  const fromId    = String(msg.from.id);
  const startParam= match[1]?.trim();

  await saveUser(msg);

  if (await isUserBanned(fromId)) {
    return bot.sendMessage(chatId, '🚫 <b>You have been banned from using this bot.</b>', { parse_mode: 'HTML' });
  }

  // Group: redirect to private
  if (msg.chat.type !== 'private') {
    if (startParam) return;
    const sent = await bot.sendMessage(chatId,
      `👋 <b>Hello! I work in Private Chat.</b>\nClick below to start:`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🤖 Start Me', url: `https://t.me/${BOT_USERNAME}` }]] }
      });
    return scheduleDelete(bot, chatId, sent.message_id, 10000);
  }

  // Deep link: /start F0001
  if (startParam && /^F\d{4,}$/i.test(startParam)) {
    const customId = startParam.toUpperCase();
    if (!await verifyJoin(bot, chatId, fromId, customId)) return;
    return deliverFile(bot, chatId, fromId, customId);
  }

  // Standard welcome
  if (!await verifyJoin(bot, chatId, fromId)) return;
  bot.sendMessage(chatId,
    `👋 <b>Welcome, ${msg.from.first_name}!</b>\n\n` +
    `🔎 <b>How to search:</b>\nSimply type the name of the movie.\n<i>Example: "Avengers" or "Breaking Bad"</i>\n\n` +
    `📂 Use /help for more details`,
    { parse_mode: 'HTML' }
  );
});

// 2. /help
bot.onText(/\/help/, async (msg) => {
  if (msg.chat.type !== 'private') {
    const sent = await bot.sendMessage(msg.chat.id,
      `ℹ️ <b>Help:</b> Type a movie/show name to search.\nTap below for full commands.`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '📖 Full Help', url: `https://t.me/${BOT_USERNAME}?start=help` }]] }
      }).catch(() => null);
    if (sent) scheduleDelete(bot, msg.chat.id, sent.message_id, 30000);
    return;
  }

  const isAdmin = ADMIN_SET.has(String(msg.from.id));
  let text =
    `📚 <b>Help Guide</b>\n\n` +
    `🔎 <b>Search:</b> Just type the movie/show name.\n` +
    `   Supports <b>fuzzy search</b> – partial names work too!\n` +
    `❤️ <b>/favorites</b> – Save files for later (max ${FAV_LIMIT_NUM}).\n` +
    `🗑️ <b>/clearfavorites</b> – Remove all your saved favorites.\n` +
    `📊 <b>/trending</b> – See what's popular this week.\n` +
    `🆕 <b>/recent</b> – Latest uploads.\n` +
    `👤 <b>/myaccount</b> – Your daily limit (${DAILY_LIMIT_NUM}/day).`;

  if (isAdmin) {
    text +=
      `\n\n👮‍♂️ <b>Admin Commands:</b>\n` +
      `/stats – Bot statistics\n` +
      `/broadcast – Message all users\n` +
      `/cancel – Cancel active broadcast\n` +
      `/delete [ID] – Remove a file\n` +
      `/ban [userId] – Ban a user\n` +
      `/unban [userId] – Unban a user`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// 3. /trending
bot.onText(/\/trending/, async (msg) => {
  const chatId  = msg.chat.id;
  const isGroup = msg.chat.type !== 'private';

  if (isGroup && !checkAndSetGroupCooldown(chatId)) return;

  await resetTrendingIfNewWeek(); // guarantees a fresh week even if the hourly check hasn't fired yet

  const files = await File.find({ weeklyDownloads: { $gt: 0 } })
    .select('customId clean_title file_size weeklyDownloads')
    .sort({ weeklyDownloads: -1 })
    .limit(TRENDING_LIMIT_NUM)
    .lean();

  if (!files.length) {
    const sent = await bot.sendMessage(chatId, 'No trending files this week yet.');
    return scheduleDelete(bot, chatId, sent.message_id, 5000);
  }

  const header  = '📈 <b>Top Trending This Week:</b>';
  const keyboard = isGroup
    ? files.map(f => [{ text: `📥 ${f.file_size} | ${f.clean_title}`, url: `https://t.me/${BOT_USERNAME}?start=${f.customId}` }])
    : files.map(f => [{ text: `🔥 ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);

  const sent = await bot.sendMessage(chatId, header, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
  }).catch(() => null);
  if (sent) scheduleDelete(bot, chatId, sent.message_id, isGroup ? GROUP_DELETE_TIME : PRIVATE_DELETE_TIME);
});

// 4. /recent
bot.onText(/\/recent/, async (msg) => {
  const chatId  = msg.chat.id;
  const isGroup = msg.chat.type !== 'private';

  if (isGroup && !checkAndSetGroupCooldown(chatId)) return;

  const files = await File.find()
    .select('customId clean_title file_size uploaded_at')
    .sort({ uploaded_at: -1 })
    .limit(RECENT_LIMIT_NUM)
    .lean();

  if (!files.length) {
    const sent = await bot.sendMessage(chatId, 'No recent files.');
    return scheduleDelete(bot, chatId, sent.message_id, 5000);
  }

  const header  = '🆕 <b>Recent Uploads:</b>';
  const keyboard = isGroup
    ? files.map(f => [{ text: `🆕 ${f.file_size} | ${f.clean_title}`, url: `https://t.me/${BOT_USERNAME}?start=${f.customId}` }])
    : files.map(f => [{ text: `📂 ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);

  const sent = await bot.sendMessage(chatId, header, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
  }).catch(() => null);
  if (sent) scheduleDelete(bot, chatId, sent.message_id, isGroup ? GROUP_DELETE_TIME : PRIVATE_DELETE_TIME);
});

// 5. /favorites
bot.onText(/\/favorites/, async (msg) => {
  if (msg.chat.type !== 'private') {
    const sent = await bot.sendMessage(msg.chat.id, `⚠️ <b>This command is for Private Chat only!</b>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🤖 Open Private Chat', url: `https://t.me/${BOT_USERNAME}` }]] }
    });
    return scheduleDelete(bot, msg.chat.id, sent.message_id, 10000);
  }

  const userId = String(msg.from.id);
  const favs   = await Favorite.find({ userId }).select('customId').lean();

  if (!favs.length) {
    const sent = await bot.sendMessage(msg.chat.id, '❤️ No favorites saved yet. Press the ❤️ button on any file to save it!');
    return scheduleDelete(bot, msg.chat.id, sent.message_id, 8000);
  }

  const allFavIds = favs.map(f => f.customId);
  const total     = allFavIds.length;
  const pageIds   = allFavIds.slice(0, RESULTS_PER_PAGE_NUM); // page 0

  const files    = await File.find({ customId: { $in: pageIds } }).select('customId clean_title file_size').lean();
  const keyboard = files.map(f => [{ text: `⭐ ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);

  if (total > RESULTS_PER_PAGE_NUM) {
    // Cache all IDs and start pagination from page 1 (0-based internally)
    const favSearchId = cacheSearchResults(userId + '_fav', allFavIds);
    keyboard.push([{ text: `Page 1 of ${Math.ceil(total / RESULTS_PER_PAGE_NUM)} ➡️`, callback_data: `PAGE_FAV:1:${favSearchId}` }]);
  }

  // total here = favs.length from Favorite collection, so it's always accurate on initial load
  const totalPages = Math.ceil(total / RESULTS_PER_PAGE_NUM);
  const headerText = total > RESULTS_PER_PAGE_NUM
    ? `❤️ <b>Your Favorites (${total}/${FAV_LIMIT_NUM}):</b>\n<i>Page 1 of ${totalPages}</i>`
    : `❤️ <b>Your Favorites (${total}/${FAV_LIMIT_NUM}):</b>`;
  const sent = await bot.sendMessage(msg.chat.id, headerText,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
  scheduleDelete(bot, msg.chat.id, sent.message_id, PRIVATE_DELETE_TIME);
});

// 5b. /clearfavorites
bot.onText(/\/clearfavorites/, async (msg) => {
  if (msg.chat.type !== 'private') {
    const sent = await bot.sendMessage(msg.chat.id, `⚠️ <b>This command is for Private Chat only!</b>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🤖 Open Private Chat', url: `https://t.me/${BOT_USERNAME}` }]] }
    });
    return scheduleDelete(bot, msg.chat.id, sent.message_id, 10000);
  }

  const userId = String(msg.from.id);
  if (await isUserBanned(userId)) return;

  try {
    const result = await Favorite.deleteMany({ userId });
    const text = result.deletedCount > 0
      ? `🗑️ <b>Cleared ${result.deletedCount} favorite(s).</b>`
      : `ℹ️ You have no saved favorites.`;
    const sent = await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
    scheduleDelete(bot, msg.chat.id, sent.message_id, 8000);
  } catch (err) {
    console.error('clearfavorites error:', err.message);
    bot.sendMessage(msg.chat.id, '⚠️ Could not clear favorites. Please try again.').catch(() => {});
  }
});

// 6. /myaccount
bot.onText(/\/myaccount/, async (msg) => {
  if (msg.chat.type !== 'private') {
    const sent = await bot.sendMessage(msg.chat.id, `⚠️ <b>This command is for Private Chat only!</b>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🤖 Open Private Chat', url: `https://t.me/${BOT_USERNAME}` }]] }
    });
    return scheduleDelete(bot, msg.chat.id, sent.message_id, 10000);
  }

  const used = await getUserLimitCount(String(msg.from.id));
  const sent = await bot.sendMessage(msg.chat.id,
    `👤 <b>Account</b>\nUsed Today: <b>${used}/${DAILY_LIMIT_NUM}</b>\n✅ Limit resets daily at midnight UTC`,
    { parse_mode: 'HTML' }
  );
  scheduleDelete(bot, msg.chat.id, sent.message_id, PRIVATE_DELETE_TIME);
});

// 7. /stats (Admin)
bot.onText(/\/stats/, async (msg) => {
  if (!ADMIN_SET.has(String(msg.from.id))) return;

  const [userCount, fileCount, bannedCount] = await Promise.all([
    User.countDocuments(),
    File.countDocuments(),
    User.countDocuments({ isBanned: true })
  ]);

  bot.sendMessage(msg.chat.id,
    `📊 <b>Bot Statistics</b>\n\n` +
    `👥 Total Users: <b>${userCount}</b>\n` +
    `🚫 Banned Users: <b>${bannedCount}</b>\n` +
    `📂 Total Files: <b>${fileCount}</b>`,
    { parse_mode: 'HTML' }
  );
});

// 8. /broadcast (Admin) with /cancel support
let broadcastAbort  = false;
let broadcastActive = false;

bot.onText(/\/cancel/, async (msg) => {
  if (!ADMIN_SET.has(String(msg.from.id))) return;
  if (!broadcastActive) {
    return bot.sendMessage(msg.chat.id, 'ℹ️ No broadcast is currently running.');
  }
  broadcastAbort = true;
  bot.sendMessage(msg.chat.id, '🛑 Broadcast cancellation requested.');
});

bot.onText(/\/broadcast(?: (.+))?/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const fromId  = String(msg.from.id);
  if (!ADMIN_SET.has(fromId)) return;

  const text     = match[1];
  const replyMsg = msg.reply_to_message;

  if (!text && !replyMsg) {
    return bot.sendMessage(chatId,
      '⚠️ <b>Usage:</b>\n1. <code>/broadcast Your message</code>\n2. Reply to any message with <code>/broadcast</code>',
      { parse_mode: 'HTML' }
    );
  }

  broadcastAbort  = false;
  broadcastActive = true;

  // Use cursor to avoid loading all users into memory
  // Use $ne:true so existing users who predate the isInactive field are included
  const cursor = User.find({ isBanned: { $ne: true }, isInactive: { $ne: true } }, { userId: 1 }).lean().cursor();

  let total = 0, success = 0, blocked = 0;
  const statusMsg = await bot.sendMessage(chatId, `🚀 Broadcast started…`);

  const CHUNK = 25;
  let chunk = [];

  async function sendToUser(userId) {
    let sent = false;
    while (!sent) {
      try {
        if (replyMsg) {
          await bot.copyMessage(userId, chatId, replyMsg.message_id);
        } else {
          await bot.sendMessage(userId, text, { parse_mode: 'HTML' });
        }
        success++;
        sent = true;
      } catch (err) {
        if (err.response?.statusCode === 429) {
          const retryAfter = err.response?.body?.parameters?.retry_after ?? 5;
          await new Promise(r => setTimeout(r, retryAfter * 1000));
        } else {
          if (err.response?.statusCode === 403) {
            blocked++;
            // Mark as inactive so future broadcasts skip them
            User.updateOne({ userId }, { $set: { isInactive: true } }).catch(() => {});
          }
          sent = true;
        }
      }
    }
  }

  async function processChunk(users) {
    for (const user of users) {
      if (broadcastAbort) break;
      await sendToUser(user.userId);
      total++;
      await new Promise(r => setTimeout(r, 50)); // rate limiting gap
    }
  }

  try {
    // Process cursor in chunks, yielding to event loop between each
    for await (const user of cursor) {
      if (broadcastAbort) break;
      chunk.push(user);
      if (chunk.length >= CHUNK) {
        await processChunk(chunk);
        chunk = [];
        // Yield to event loop
        await new Promise(r => setImmediate(r));
      }
    }
    if (chunk.length) await processChunk(chunk);
  } catch (broadcastErr) {
    console.error('Broadcast error:', broadcastErr);
  } finally {
    // Always reset flag so /cancel and future /broadcast work correctly
    broadcastActive = false;
  }

  const status = broadcastAbort ? '🛑 Broadcast cancelled' : '✅ Broadcast complete';
  bot.editMessageText(
    `${status}\n\n📤 Sent: <b>${success}</b>\n🚫 Blocked/Inactive: <b>${blocked}</b>\n👥 Reached: <b>${total}</b>`,
    { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }
  ).catch(() => {});
});

// 9. /delete (Admin)
bot.onText(/\/delete (.+)/, async (msg, match) => {
  if (!ADMIN_SET.has(String(msg.from.id))) return;

  const customId = match[1].trim().toUpperCase();
  const result   = await File.deleteOne({ customId });

  bot.sendMessage(msg.chat.id,
    result.deletedCount > 0
      ? `🗑️ <b>Deleted:</b> File <code>${customId}</code> has been removed.`
      : `❌ <b>Not found:</b> <code>${customId}</code>`,
    { parse_mode: 'HTML' }
  );
});

// 10. /ban (Admin)
bot.onText(/\/ban (.+)/, async (msg, match) => {
  if (!ADMIN_SET.has(String(msg.from.id))) return;

  const targetId = match[1].trim();
  const result   = await User.findOneAndUpdate({ userId: targetId }, { isBanned: true }, { new: true });

  if (result) {
    invalidateBanCache(targetId); // immediate cache invalidation
    bot.sendMessage(msg.chat.id, `🚫 <b>User <code>${targetId}</code> has been banned.</b>`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(msg.chat.id, `❌ User <code>${targetId}</code> not found in database.`, { parse_mode: 'HTML' });
  }
});

// 11. /unban (Admin)
bot.onText(/\/unban (.+)/, async (msg, match) => {
  if (!ADMIN_SET.has(String(msg.from.id))) return;

  const targetId = match[1].trim();
  const result   = await User.findOneAndUpdate({ userId: targetId }, { isBanned: false }, { new: true });

  if (result) {
    invalidateBanCache(targetId); // immediate cache invalidation
    bot.sendMessage(msg.chat.id, `✅ <b>User <code>${targetId}</code> has been unbanned.</b>`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(msg.chat.id, `❌ User <code>${targetId}</code> not found in database.`, { parse_mode: 'HTML' });
  }
});

// ============================================================
// --- MAIN MESSAGE HANDLER (search pipeline) ---
// ============================================================
bot.on('message', async (msg) => {
  // Bot added to group
  if (msg.new_chat_members) {
    const isMe = msg.new_chat_members.find(m => m.username === BOT_USERNAME);
    if (isMe) {
      return bot.sendMessage(msg.chat.id,
        `👋 <b>Thanks for adding me!</b>\n\n` +
        `ℹ️ <b>How to use:</b>\n` +
        `1. Make me an <b>Admin</b>.\n` +
        `2. Users can type movie names to search.\n` +
        `3. I will send a download link button (Files delivered via Private DM).\n\n` +
        `🚀 <i>Enjoy!</i>`,
        { parse_mode: 'HTML' }
      );
    }
  }

  if (!msg.text || msg.text.startsWith('/') || msg.from?.is_bot || msg.chat.type === 'channel') return;

  const chatId  = msg.chat.id;
  const fromId  = String(msg.from.id);
  const isGroup = msg.chat.type !== 'private';
  const text    = msg.text.trim();

  if (text.length < 3) return;

  // Pipeline: Ban → Cooldown (group) → Member check → Search
  if (await isUserBanned(fromId)) return;

  if (isGroup) {
    if (!checkAndSetGroupCooldown(chatId)) return;

    const { files: allMatches, isFuzzy } = await searchFiles(text, 100);

    if (allMatches.length > 0) {
      const groupSearchId = cacheSearchResults(fromId, allMatches.map(f => f.customId));
      const { ids: gIds, total: gTotal } = getCachedPage(fromId, groupSearchId, 0);
      const gFiles = await File.find({ customId: { $in: gIds } })
        .select('customId clean_title file_size')
        .sort({ uploaded_at: -1 })
        .lean();

      const header   = isFuzzy
        ? `🔍 <b>Fuzzy results for "${text}" (${gTotal} total):</b>`
        : `🔍 <b>Found ${gTotal} result(s):</b>`;
      const keyboard = gFiles.map(f => [{
        text: `${f.file_size}  |  ${f.clean_title}`,
        url:  `https://t.me/${BOT_USERNAME}?start=${f.customId}`
      }]);
      if (gTotal > RESULTS_PER_PAGE_NUM) {
        keyboard.push([{ text: `Page 1 of ${Math.ceil(gTotal / RESULTS_PER_PAGE_NUM)} ➡️`, callback_data: `PAGE_G:1:${groupSearchId}` }]);
      }
      const sent = await bot.sendMessage(chatId, header, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
      }).catch(() => null);
      if (sent) scheduleDelete(bot, chatId, sent.message_id, GROUP_DELETE_TIME);

    } else {
      const sent = await bot.sendMessage(chatId,
        `🤷‍♂️ <b>Could not find "${text}"</b>\nTry checking the spelling.`,
        { parse_mode: 'HTML' }
      ).catch(() => null);
      if (sent) scheduleDelete(bot, chatId, sent.message_id, NO_RESULT_DELETE_TIME);
    }
    return;
  }

  // ---- PRIVATE SEARCH ----
  await saveUser(msg);
  if (!await verifyJoin(bot, chatId, fromId)) return;

  try {
    const { files: allMatches, isFuzzy } = await searchFiles(text, 100);

    if (!allMatches.length) {
      const sent = await bot.sendMessage(chatId,
        `🔍 <b>No results for "${text}".</b>\nTry different keywords or check spelling.`,
        { parse_mode: 'HTML' }
      );
      return scheduleDelete(bot, chatId, sent.message_id, NO_RESULT_DELETE_TIME);
    }

    const searchId    = cacheSearchResults(fromId, allMatches.map(f => f.customId));
    const { ids, total } = getCachedPage(fromId, searchId, 0);
    const files       = await File.find({ customId: { $in: ids } })
      .select('customId clean_title file_size')
      .sort({ uploaded_at: -1 })
      .lean();

    const header   = isFuzzy
      ? `🔍 Found <b>${total}</b> fuzzy match(es) for "<i>${text}</i>":`
      : `🔍 Found <b>${total}</b> file(s):`;
    const keyboard = files.map(f => [{ text: formatSearchBtn(f), callback_data: `GET:${f.customId}` }]);

    if (total > RESULTS_PER_PAGE_NUM) {
      keyboard.push([{ text: `Page 1 of ${Math.ceil(total / RESULTS_PER_PAGE_NUM)} ➡️`, callback_data: `PAGE:1:${searchId}` }]);
    }

    const sent = await bot.sendMessage(chatId, header, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
    }).catch(() => null);
    if (sent) scheduleDelete(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);

  } catch (err) {
    console.error('Private search error:', err);
    const sent = await bot.sendMessage(chatId,
      `⚠️ <b>Something went wrong while searching.</b>\nPlease try again in a moment.`,
      { parse_mode: 'HTML' }
    ).catch(() => null);
    if (sent) scheduleDelete(bot, chatId, sent.message_id, NO_RESULT_DELETE_TIME);
  }
});

// ============================================================
// --- CALLBACKS ---
// ============================================================
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const fromId = String(q.from.id);
  const data   = q.data;

  try {
    // Pipeline: Ban check first
    if (await isUserBanned(fromId)) {
      return bot.answerCallbackQuery(q.id, { text: '🚫 You are banned.', show_alert: true });
    }

    // CHECK_JOIN — skip member check here (user is confirming join)
    if (data.startsWith('CHECK_JOIN')) {
      const fileCode = data.split(':')[1] || null;
      clearMemberCacheEntry(fromId);

      if (await verifyJoin(bot, chatId, fromId, fileCode)) {
        // Must answer callback query first — otherwise button spins forever
        await bot.answerCallbackQuery(q.id, { text: '✅ Verified!' });
        bot.sendMessage(chatId, '✅ Thanks! You can now search for files.');
        bot.deleteMessage(chatId, q.message.message_id).catch(() => {});
      } else {
        bot.answerCallbackQuery(q.id, { text: '❌ You have not joined yet!', show_alert: true });
      }
      return;
    }

    // All other callbacks require join verification
    if (!await verifyJoin(bot, chatId, fromId)) {
      return bot.answerCallbackQuery(q.id, { text: 'Please join the channel first!' });
    }

    // --- PAGINATION (private search) ---
    if (data.startsWith('PAGE:')) {
      const [, pageStr, searchId] = data.split(':');
      const page = Number(pageStr);
      if (!searchId) return bot.answerCallbackQuery(q.id, { text: 'Search session expired. Please search again.' });

      const { ids, total } = getCachedPage(fromId, searchId, page);
      if (!ids.length) return bot.answerCallbackQuery(q.id, { text: 'Search expired. Please search again.' });

      const files    = await File.find({ customId: { $in: ids } })
        .select('customId clean_title file_size')
        .sort({ uploaded_at: -1 })
        .lean();
      const keyboard = files.map(f => [{ text: formatSearchBtn(f), callback_data: `GET:${f.customId}` }]);
      const nav      = [];
      if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `PAGE:${page - 1}:${searchId}` });
      if ((page + 1) * RESULTS_PER_PAGE_NUM < total) nav.push({ text: 'Next ➡️', callback_data: `PAGE:${page + 1}:${searchId}` });
      if (nav.length) keyboard.push(nav);

      await bot.editMessageText(
        `🔍 Results — Page <b>${page + 1}</b> of <b>${Math.ceil(total / RESULTS_PER_PAGE_NUM)}</b>`,
        { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
      );
      bot.answerCallbackQuery(q.id);
      return;
    }

    // --- FAVORITES PAGINATION ---
    if (data.startsWith('PAGE_FAV:')) {
      const [, pageStr, searchId] = data.split(':');
      const page = Number(pageStr);
      if (!searchId) return bot.answerCallbackQuery(q.id, { text: 'Session expired. Please run /favorites again.' });

      const { ids, total: cachedTotal } = getCachedPage(fromId + '_fav', searchId, page);
      if (!ids.length) return bot.answerCallbackQuery(q.id, { text: 'Session expired. Please run /favorites again.' });

      // Fetch fresh count from DB so header stays accurate even if files were deleted
      const [files, freshTotal] = await Promise.all([
        File.find({ customId: { $in: ids } }).select('customId clean_title file_size').lean(),
        Favorite.countDocuments({ userId: fromId })
      ]);
      const keyboard   = files.map(f => [{ text: `⭐ ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);
      const nav        = [];
      if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `PAGE_FAV:${page - 1}:${searchId}` });
      if ((page + 1) * RESULTS_PER_PAGE_NUM < cachedTotal) nav.push({ text: 'Next ➡️', callback_data: `PAGE_FAV:${page + 1}:${searchId}` });
      if (nav.length) keyboard.push(nav);

      const totalPages = Math.ceil(cachedTotal / RESULTS_PER_PAGE_NUM);
      await bot.editMessageText(
        `❤️ <b>Your Favorites (${freshTotal}/${FAV_LIMIT_NUM}):</b>\n<i>Page ${page + 1} of ${totalPages}</i>`,
        { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
      );
      bot.answerCallbackQuery(q.id);
      return;
    }

    // --- GROUP PAGINATION ---
    if (data.startsWith('PAGE_G:')) {
      const [, pageStr, searchId] = data.split(':');
      const page = Number(pageStr);
      if (!searchId) return bot.answerCallbackQuery(q.id, { text: 'Search session expired. Please search again.' });

      const { ids, total } = getCachedPage(fromId, searchId, page);
      if (!ids.length) return bot.answerCallbackQuery(q.id, { text: 'Search expired. Please search again.' });

      const files    = await File.find({ customId: { $in: ids } })
        .select('customId clean_title file_size')
        .sort({ uploaded_at: -1 })
        .lean();
      const keyboard = files.map(f => [{
        text: `${f.file_size}  |  ${f.clean_title}`,
        url:  `https://t.me/${BOT_USERNAME}?start=${f.customId}`
      }]);
      const nav = [];
      if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `PAGE_G:${page - 1}:${searchId}` });
      if ((page + 1) * RESULTS_PER_PAGE_NUM < total) nav.push({ text: 'Next ➡️', callback_data: `PAGE_G:${page + 1}:${searchId}` });
      if (nav.length) keyboard.push(nav);

      await bot.editMessageText(
        `🔍 Results — Page <b>${page + 1}</b> of <b>${Math.ceil(total / RESULTS_PER_PAGE_NUM)}</b>`,
        { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
      );
      bot.answerCallbackQuery(q.id);
      return;
    }

    // --- GET FILE ---
    if (data.startsWith('GET:')) {
      const customId = data.split(':')[1];
      // answerCallbackQuery first so the button stops spinning immediately
      await bot.answerCallbackQuery(q.id, { text: '📤 Sending file...' });
      // deliverFile handles "file not found" internally — no pre-check needed
      await deliverFile(bot, chatId, fromId, customId);
      return;
    }

    // --- FAVORITE TOGGLE ---
    if (data.startsWith('FAV:')) {
      const customId = data.split(':')[1];
      const exists   = await Favorite.findOne({ userId: fromId, customId }).select('_id').lean();

      if (exists) {
        await Favorite.deleteOne({ userId: fromId, customId });
        bot.answerCallbackQuery(q.id, { text: '💔 Removed from favorites.' });
      } else {
        const count = await Favorite.countDocuments({ userId: fromId });
        if (count >= FAV_LIMIT_NUM) {
          return bot.answerCallbackQuery(q.id, {
            text: `❌ Max ${FAV_LIMIT_NUM} favorites allowed. Remove one first.`,
            show_alert: true
          });
        }
        await Favorite.create({ userId: fromId, customId });
        bot.answerCallbackQuery(q.id, { text: '❤️ Saved to favorites!' });
      }
      return;
    }

  } catch (e) {
    console.error('Callback Error:', e);
    bot.answerCallbackQuery(q.id, { text: '⚠️ Something went wrong. Please try again.' });
  }
});

// ============================================================
// --- GRACEFUL SHUTDOWN ---
// ============================================================
async function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
