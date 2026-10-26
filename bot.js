import dotenv from 'dotenv';
dotenv.config();

import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns';
import TelegramBot from 'node-telegram-bot-api';
import mongoose from 'mongoose';
import express from 'express';

net.setDefaultAutoSelectFamily?.(false);
dns.setDefaultResultOrder?.('ipv4first');

let shuttingDown    = false;
let server          = null;
const intervals     = [];
let broadcastAbort  = false;
let broadcastActive = false;

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException', 1);
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const env = process.env;
const configErrors = [];

function envInt(name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    configErrors.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
    return def;
  }
  return n;
}

const TELEGRAM_TOKEN     = (env.TELEGRAM_TOKEN || '').trim();
const MONGODB_URI        = (env.MONGODB_URI || '').trim();
const STORAGE_CHANNEL_ID = String(env.STORAGE_CHANNEL_ID || '').trim();
const FORCE_CHANNEL_ID   = (env.FORCE_CHANNEL_ID || '').trim() || null;
const FORCE_CHANNEL_LINK = (env.FORCE_CHANNEL_LINK || '').trim() || null;
if (FORCE_CHANNEL_LINK && !/^https:\/\/t\.me\/\S+$/.test(FORCE_CHANNEL_LINK)) {
  configErrors.push('FORCE_CHANNEL_LINK must be an https://t.me/... link');
}
const RENDER_EXTERNAL_URL = (env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');

if (!/^\d+:[\w-]{30,}$/.test(TELEGRAM_TOKEN)) configErrors.push('TELEGRAM_TOKEN is missing or malformed');
if (!/^mongodb(\+srv)?:\/\//.test(MONGODB_URI)) configErrors.push('MONGODB_URI is missing or must start with mongodb:// or mongodb+srv://');
if (!/^-?\d+$/.test(STORAGE_CHANNEL_ID)) configErrors.push('STORAGE_CHANNEL_ID must be a numeric chat id (e.g. -1001234567890)');
if (FORCE_CHANNEL_ID && !/^(@\w{4,}|-?\d+)$/.test(FORCE_CHANNEL_ID)) configErrors.push('FORCE_CHANNEL_ID must be @username or a numeric chat id');
try {
  if (new URL(RENDER_EXTERNAL_URL).protocol !== 'https:') configErrors.push('RENDER_EXTERNAL_URL must be an https URL (Telegram webhooks require HTTPS)');
} catch {
  configErrors.push('RENDER_EXTERNAL_URL is missing or not a valid URL');
}

const ADMIN_SET = new Set();
for (const id of (env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)) {
  if (/^\d+$/.test(id)) ADMIN_SET.add(id);
  else configErrors.push(`ADMIN_IDS contains an invalid user id: "${id}"`);
}

const DAILY_LIMIT_NUM       = envInt('DAILY_LIMIT',            100,   1, 100000);
const RESULTS_PER_PAGE_NUM  = envInt('RESULTS_PER_PAGE',       10,    1, 50);
const FAV_LIMIT_NUM         = envInt('FAV_LIMIT',              50,    1, 1000);
const PRIVATE_DELETE_TIME   = envInt('PRIVATE_AUTO_DELETE_MS', 60000, 1000, 172800000);
const GROUP_DELETE_TIME     = envInt('GROUP_AUTO_DELETE_MS',   60000, 1000, 172800000);
const GROUP_COOLDOWN_TIME   = envInt('GROUP_COOLDOWN_MS',      2000,  0, 3600000);
const NO_RESULT_DELETE_TIME = envInt('NO_RESULT_DELETE_MS',    60000, 1000, 172800000);
const TRENDING_LIMIT_NUM    = envInt('TRENDING_LIMIT',         10,    1, 50);
const RECENT_LIMIT_NUM      = envInt('RECENT_LIMIT',           10,    1, 50);
const FUZZY_MIN_LEN         = envInt('FUZZY_MIN_WORD_LEN',     3,     1, 20);
const LIMIT_DOC_TTL_DAYS    = envInt('LIMIT_DOC_TTL_DAYS',     2,     1, 365);
const PORT                  = envInt('PORT',                   3000,  1, 65535);

if (env.WEBHOOK_SECRET && !/^[A-Za-z0-9_-]{16,256}$/.test(env.WEBHOOK_SECRET.trim())) {
  configErrors.push('WEBHOOK_SECRET must be 16-256 chars of A-Z a-z 0-9 _ -');
}
const WEBHOOK_SECRET = env.WEBHOOK_SECRET?.trim() ||
  crypto.createHash('sha256').update(`webhook:${TELEGRAM_TOKEN}`).digest('hex');
const WEBHOOK_PATH   = `/webhook/${WEBHOOK_SECRET}`;
const WEBHOOK_SECRET_BUF = Buffer.from(WEBHOOK_SECRET);

if (configErrors.length) {
  console.error('❌ Invalid configuration:\n - ' + configErrors.join('\n - '));
  process.exit(1);
}

const STORAGE_CHANNEL_ID_STR = STORAGE_CHANNEL_ID;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const isAdmin = (msg) => !!msg.from && ADMIN_SET.has(String(msg.from.id));
const utcDay  = () => new Date().toISOString().slice(0, 10);
const FILE_ID_RE = /^F\d{4,}$/;

class TTLCache {
  constructor(ttlMs, maxSize = 10000) {
    this._map = new Map();
    this._ttl = ttlMs;
    this._max = maxSize;
    setInterval(() => this._sweep(), 5 * 60 * 1000).unref();
  }
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) { this._map.delete(key); return undefined; }
    return entry.value;
  }
  set(key, value) {
    this._map.delete(key);
    this._map.set(key, { value, expiresAt: Date.now() + this._ttl });
    while (this._map.size > this._max) this._map.delete(this._map.keys().next().value);
  }
  delete(key) { this._map.delete(key); }
  _sweep() {
    const now = Date.now();
    for (const [k, e] of this._map) if (now > e.expiresAt) this._map.delete(k);
  }
}

const banCache           = new TTLCache(5 * 60 * 1000);
const memberCache        = new TTLCache(15 * 60 * 1000);
const groupCooldownCache = new TTLCache(Math.max(GROUP_COOLDOWN_TIME, 1));
const userSeenCache      = new TTLCache(60 * 60 * 1000);
const searchResultCache  = new TTLCache(5 * 60 * 1000, 5000);

const pendingDeletions = new Map();

function scheduleDelete(bot, chatId, messageId, delayMs) {
  if (shuttingDown) return;
  const key = `${chatId}:${messageId}`;
  if (pendingDeletions.has(key)) return;
  const t = setTimeout(async () => {
    pendingDeletions.delete(key);
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (e) {
      if (!/message to delete not found|message can't be deleted/i.test(e.message || '')) {
        console.warn('Delete error (non-fatal):', e.message);
      }
    }
  }, delayMs);
  pendingDeletions.set(key, t);
}

mongoose.connection.on('error', (e) => console.error('MongoDB error:', e.message));
mongoose.connection.on('disconnected', () => { if (!shuttingDown) console.warn('⚠️ MongoDB disconnected'); });

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
  message_id: { type: Number, required: true, unique: true },
  file_name:  String,
  type:       String,
  file_size:  String,
  clean_title:String,
  attributes: [String],
  uploaded_at:{ type: Date, default: Date.now, index: true },
  downloads:  { type: Number, default: 0 },
  weeklyDownloads: { type: Number, default: 0, index: true }
});
FileSchema.index({ attributes: 1, uploaded_at: -1 });
const File = mongoose.model('File', FileSchema);
File.on('index', (err) => { if (err) console.error('File index build error (check for duplicate message_id):', err.message); });

const SettingSchema = new Schema({ _id: String, value: String });
const Setting = mongoose.model('Setting', SettingSchema);

const CounterSchema = new Schema({ _id: String, seq: Number });
const Counter = mongoose.model('Counter', CounterSchema);

const LimitSchema = new Schema({
  userId:    String,
  date:      String,
  count:     { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: LIMIT_DOC_TTL_DAYS * 86400 }
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

const TRANSIENT_RE = /ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|EPIPE|EHOSTUNREACH|ENETUNREACH|AggregateError|socket hang up/i;

function isTransient(err, depth = 0) {
  if (!err || depth > 4) return false;
  const status = err.response?.statusCode;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (err.code === 'EFATAL') return true;
  if (TRANSIENT_RE.test(`${err.name ?? ''} ${err.code ?? ''} ${err.message ?? ''}`)) return true;
  if (Array.isArray(err.errors) && err.errors.some(e => isTransient(e, depth + 1))) return true;
  return isTransient(err.cause, depth + 1);
}

const MAX_RETRY_AFTER_S = 10;

async function withRetry(fn, { attempts = 3, label = 'telegram' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts) break;
      let delay = Math.min(500 * 2 ** (i - 1), 4000) + Math.floor(Math.random() * 250);
      if (err?.response?.statusCode === 429) {
        const retryAfter = err.response?.body?.parameters?.retry_after ?? 1;
        if (retryAfter > MAX_RETRY_AFTER_S) break;
        delay = Math.max(delay, retryAfter * 1000);
      }
      console.warn(`⚠️ ${label} transient error (attempt ${i}/${attempts}): ${err.message} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  request: {
    timeout: 30000,
    agentOptions: { keepAlive: true, family: 4 },
  },
});

for (const method of [
  'sendMessage', 'editMessageText', 'editMessageCaption', 'copyMessage',
  'deleteMessage', 'getChatMember', 'createChatInviteLink', 'getMe', 'setMyCommands',
]) {
  const original = bot[method].bind(bot);
  bot[method] = (...args) => withRetry(() => original(...args), { label: method });
}

{
  const original = bot.answerCallbackQuery.bind(bot);
  bot.answerCallbackQuery = async (...args) => {
    try {
      return await withRetry(() => original(...args), { attempts: 2, label: 'answerCallbackQuery' });
    } catch (err) {
      console.warn('answerCallbackQuery failed (ignored):', err.message);
      return false;
    }
  };
}

bot.on('error', (e) => console.error('Bot error:', e.message));
bot.on('webhook_error', (e) => console.error('Webhook error:', e.message));

async function safeEdit(text, options) {
  try {
    await bot.editMessageText(text, options);
  } catch (err) {
    if (/message is not modified|message to edit not found|message can't be edited/i.test(err.message || '')) return;
    throw err;
  }
}

const BOT_ME = await bot.getMe();
const BOT_USERNAME = BOT_ME.username;
console.log(`✅ Bot @${BOT_USERNAME} ready`);

function currentWeekKey() {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

let trendingWeekChecked  = null;
let trendingResetInFlight = null;

function resetTrendingIfNewWeek() {
  const weekKey = currentWeekKey();
  if (trendingWeekChecked === weekKey) return Promise.resolve();
  if (trendingResetInFlight) return trendingResetInFlight;

  trendingResetInFlight = (async () => {
    let claimed = false;
    let previous = '';
    try {
      const prev = await Setting.findById('trendingWeek').lean();
      if (prev?.value === weekKey) { trendingWeekChecked = weekKey; return; }
      previous = prev?.value ?? '';

      const r = await Setting.updateOne(
        { _id: 'trendingWeek', value: { $ne: weekKey } },
        { $set: { value: weekKey } },
        { upsert: true }
      );
      claimed = r.modifiedCount === 1 || r.upsertedCount === 1;
      if (!claimed) { trendingWeekChecked = weekKey; return; }

      const res = await File.updateMany({ weeklyDownloads: { $gt: 0 } }, { $set: { weeklyDownloads: 0 } });
      trendingWeekChecked = weekKey;
      console.log(`🔄 Weekly trending reset (week of ${weekKey}), ${res.modifiedCount} files cleared`);
    } catch (e) {
      if (e.code === 11000 && !claimed) { trendingWeekChecked = weekKey; return; }
      console.error('Trending reset error:', e.message);
      if (claimed) {
        await Setting.updateOne({ _id: 'trendingWeek' }, { $set: { value: previous } }).catch(() => {});
      }
    } finally {
      trendingResetInFlight = null;
    }
  })();
  return trendingResetInFlight;
}

await resetTrendingIfNewWeek();
intervals.push(setInterval(() => resetTrendingIfNewWeek(), 60 * 60 * 1000));

async function nextSequence(name = 'file') {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  ).lean();
  return 'F' + String(doc.seq).padStart(4, '0');
}

async function reserveDownload(userId) {
  const date = utcDay();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await Limit.findOneAndUpdate(
        { userId, date, count: { $lt: DAILY_LIMIT_NUM } },
        { $inc: { count: 1 }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: false }
      ).lean();
      return { ok: true, date };
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  return { ok: false, date };
}

async function refundDownload(userId, date) {
  try {
    await Limit.updateOne({ userId, date, count: { $gt: 0 } }, { $inc: { count: -1 } });
  } catch (e) {
    console.error('Refund failed:', e.message);
  }
}

async function getUserLimitCount(userId) {
  const doc = await Limit.findOne({ userId, date: utcDay() }).select('count').lean();
  return doc?.count || 0;
}

async function saveUser(msg, force = false) {
  if (!msg.from || msg.from.is_bot) return;
  const userId = String(msg.from.id);
  if (!force && userSeenCache.get(userId)) return;
  userSeenCache.set(userId, true);
  await User.updateOne(
    { userId },
    {
      $set: { firstName: msg.from.first_name, username: msg.from.username, isInactive: false },
      $setOnInsert: { joinedAt: new Date(), isBanned: false }
    },
    { upsert: true }
  ).catch(err => {
    userSeenCache.delete(userId);
    console.error('saveUser error:', err.message);
  });
}

async function isUserBanned(userId) {
  const cached = banCache.get(userId);
  if (cached !== undefined) return cached;
  const user = await User.findOne({ userId }, { isBanned: 1 }).lean();
  const banned = user?.isBanned === true;
  banCache.set(userId, banned);
  return banned;
}
const invalidateBanCache = (userId) => banCache.delete(userId);

const getMemberCache        = (userId) => memberCache.get(userId) ?? null;
const setMemberCacheEntry   = (userId, v) => memberCache.set(userId, v);
const clearMemberCacheEntry = (userId) => memberCache.delete(userId);

function checkAndSetGroupCooldown(chatId) {
  const key = String(chatId);
  if (GROUP_COOLDOWN_TIME === 0) return true;
  if (groupCooldownCache.get(key) !== undefined) return false;
  groupCooldownCache.set(key, true);
  return true;
}

function cacheSearchResults(ownerId, fileIds, kind) {
  const searchId = crypto.randomBytes(6).toString('base64url');
  searchResultCache.set(searchId, { ownerId: String(ownerId), kind, ids: fileIds });
  return searchId;
}

function getCachedPage(searchId, page, ownerId, kind) {
  const entry = searchResultCache.get(searchId);
  if (!entry || entry.kind !== kind) return { status: 'expired', ids: [], total: 0 };
  if (entry.ownerId !== String(ownerId)) return { status: 'forbidden', ids: [], total: 0 };
  const total   = entry.ids.length;
  const maxPage = Math.max(0, Math.ceil(total / RESULTS_PER_PAGE_NUM) - 1);
  if (!Number.isInteger(page) || page < 0 || page > maxPage) return { status: 'invalid', ids: [], total };
  const start = page * RESULTS_PER_PAGE_NUM;
  return { status: 'ok', ids: entry.ids.slice(start, start + RESULTS_PER_PAGE_NUM), total };
}

async function fetchFilesInOrder(ids) {
  if (!ids.length) return [];
  const docs = await File.find({ customId: { $in: ids } }).select('customId clean_title file_size').lean();
  const byId = new Map(docs.map(d => [d.customId, d]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

const formatSearchBtn = (f) => `${f.file_size}  |  ${f.clean_title}`;

function cleanFileName(text) {
  return text
    .replace(/\.(mkv|mp4|avi|mov|flv|wmv|webm|m4v)$/i, '')
    .replace(/@\w+/g, '')
    .replace(/[\[\]\(\)\{\}\.\;\:\~\|\,\_\-\+\?\!\&\#\*\"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSize(bytes) {
  if (!bytes) return 'Unknown';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(1) + ' KB';
}

const privateOnlyReply = async (chatId) => {
  const sent = await bot.sendMessage(chatId, `⚠️ <b>This command is for Private Chat only!</b>`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🤖 Open Private Chat', url: `https://t.me/${BOT_USERNAME}` }]] }
  });
  scheduleDelete(bot, chatId, sent.message_id, 10000);
};

const deliveryLocks = new Set();

async function deliverFile(bot, chatId, fromId, customId) {
  const lockKey = `${fromId}:${customId}`;
  if (deliveryLocks.has(lockKey)) return;
  deliveryLocks.add(lockKey);
  try {
    const file = await File.findOne({ customId })
      .select('message_id clean_title file_size type customId _id')
      .lean();
    if (!file) return bot.sendMessage(chatId, '❌ File no longer exists.');

    const reservation = await reserveDownload(fromId);
    if (!reservation.ok) {
      return bot.sendMessage(chatId,
        `⚠️ Daily limit of <b>${DAILY_LIMIT_NUM}</b> reached. Resets at midnight UTC.`,
        { parse_mode: 'HTML' }
      );
    }

    let sent;
    try {
      sent = await bot.copyMessage(chatId, STORAGE_CHANNEL_ID, file.message_id, {
        caption:
          `🎬 <b>${esc(file.clean_title)}</b>\n` +
          `🆔 ID: <code>${esc(file.customId)}</code>\n\n` +
          `⚠️ <i>Auto-deletes in ${PRIVATE_DELETE_TIME / 1000}s</i>`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '❤️ Add to Favorites', callback_data: `FAV:${file.customId}` }]] }
      });
    } catch (err) {
      await refundDownload(fromId, reservation.date);
      console.error('copyMessage failed in deliverFile:', err.message);
      const gone = /message to copy not found|message not found/i.test(err.message || '');
      return bot.sendMessage(chatId,
        gone ? '❌ This file is no longer available.' : '⚠️ Could not send the file. Please try again.'
      ).catch(() => {});
    }

    File.updateOne({ _id: file._id }, { $inc: { downloads: 1, weeklyDownloads: 1 } })
      .catch(e => console.error('Download counter update failed:', e.message));
    scheduleDelete(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
  } finally {
    deliveryLocks.delete(lockKey);
  }
}

async function searchFiles(query, limit = 100) {
  if (query.length > 100) return { files: [], isFuzzy: false };

  const keywords = [...new Set(cleanFileName(query).toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
  if (!keywords.length) return { files: [], isFuzzy: false };

  const exact = await File.find({ attributes: { $all: keywords } })
    .select('customId clean_title file_size uploaded_at')
    .sort({ uploaded_at: -1 })
    .limit(limit)
    .lean();

  if (exact.length) return { files: exact, isFuzzy: false };

  const fuzzyWords = keywords.filter(w => w.length >= FUZZY_MIN_LEN);
  if (!fuzzyWords.length) return { files: [], isFuzzy: false };

  const regexConditions = fuzzyWords.map(w => ({
    attributes: { $regex: '^' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
  }));

  const fuzzy = await File.find({ $or: regexConditions })
    .select('customId clean_title file_size uploaded_at')
    .sort({ uploaded_at: -1 })
    .limit(limit)
    .lean();

  return { files: fuzzy, isFuzzy: true };
}

let forceLinkUrl = null;
let forceLinkPending = null;

async function getForceChannelLink() {
  if (FORCE_CHANNEL_LINK) return FORCE_CHANNEL_LINK;
  if (FORCE_CHANNEL_ID.startsWith('@')) return `https://t.me/${FORCE_CHANNEL_ID.slice(1)}`;
  if (forceLinkUrl) return forceLinkUrl;
  if (forceLinkPending) return forceLinkPending;

  forceLinkPending = (async () => {
    try {
      const saved = await Setting.findById('forceInviteLink').lean();
      if (saved?.value) return (forceLinkUrl = saved.value);

      const created = await bot.createChatInviteLink(FORCE_CHANNEL_ID, { name: 'bot-force-join' });
      forceLinkUrl = created.invite_link;
      await Setting.updateOne({ _id: 'forceInviteLink' }, { $set: { value: forceLinkUrl } }, { upsert: true })
        .catch(e => console.warn('Could not persist invite link:', e.message));
      return forceLinkUrl;
    } catch (err) {
      console.error('Could not get force-join invite link (set FORCE_CHANNEL_LINK to avoid this):', err.message);
      return null;
    } finally {
      forceLinkPending = null;
    }
  })();
  return forceLinkPending;
}

async function verifyJoin(bot, chatId, userId, fileCode = null, { quiet = false } = {}) {
  if (!FORCE_CHANNEL_ID) return true;
  if (ADMIN_SET.has(userId)) return true;
  if (getMemberCache(userId) === true) return true;

  try {
    const member = await bot.getChatMember(FORCE_CHANNEL_ID, userId);
    const isMember = ['creator', 'administrator', 'member'].includes(member.status) ||
                     (member.status === 'restricted' && member.is_member === true);

    if (isMember) {
      setMemberCacheEntry(userId, true);
      return true;
    }

    if (!quiet) {
      const channelLink = await getForceChannelLink();
      const callbackData = fileCode ? `CHECK_JOIN:${fileCode}` : 'CHECK_JOIN';
      const rows = [];
      if (channelLink) rows.push([{ text: '📢 Join Channel', url: channelLink }]);
      rows.push([{ text: '✅ I Have Joined', callback_data: callbackData }]);
      await bot.sendMessage(chatId, '⚠️ <b>You must join our channel to use this bot.</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows }
      });
    }
    return false;
  } catch (err) {
    console.error('Force Join Error:', err.message);
    if (isTransient(err)) {
      if (!quiet) await bot.sendMessage(chatId, '⚠️ Could not verify channel membership right now. Please try again in a moment.').catch(() => {});
      return false;
    }
    return true;
  }
}

async function guard(msg, { join = true } = {}) {
  if (!msg.from || msg.from.is_bot) return false;
  const fromId = String(msg.from.id);
  if (await isUserBanned(fromId)) return false;
  if (join && msg.chat.type === 'private') return verifyJoin(bot, msg.chat.id, fromId);
  return true;
}

const app = express();
app.disable('x-powered-by');

function validSecretHeader(value) {
  if (typeof value !== 'string') return false;
  const given = Buffer.from(value);
  return given.length === WEBHOOK_SECRET_BUF.length && crypto.timingSafeEqual(given, WEBHOOK_SECRET_BUF);
}

app.post(WEBHOOK_PATH, express.json({ limit: '1mb' }), (req, res) => {
  if (!validSecretHeader(req.get('x-telegram-bot-api-secret-token'))) return res.sendStatus(403);
  if (shuttingDown) return res.sendStatus(503);
  res.sendStatus(200);
  try {
    bot.processUpdate(req.body);
  } catch (err) {
    console.error('processUpdate error:', err);
  }
});

app.get('/', (_, res) => res.send('Bot is running. 🚀'));
app.use((err, _req, res, _next) => {
  console.warn('HTTP error:', err.message);
  res.sendStatus(err.status || 400);
});

server = app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));

async function selfPing() {
  if (shuttingDown) return;
  try {
    const res = await fetch(RENDER_EXTERNAL_URL, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Connection': 'keep-alive',
      }
    });
    if (!res.ok) console.warn(`⚠️ Self-ping unexpected status: ${res.status}`);
  } catch (err) {
    console.warn(`⚠️ Self-ping failed: ${err.message}`);
  }
}
intervals.push(setInterval(selfPing, 14 * 60 * 1000));
setTimeout(selfPing, 5000).unref();

function command(name, handler) {
  const re = new RegExp(`^/${name}(?:@${BOT_USERNAME})?(?:\\s+([\\s\\S]+))?$`, 'i');
  bot.onText(re, (msg, match) => {
    Promise.resolve()
      .then(() => handler(msg, match))
      .catch(err => console.error(`/${name} handler error:`, err));
  });
}

bot.setMyCommands([
  { command: 'start',      description: '🔄 Restart Bot' },
  { command: 'recent',     description: '🆕 New Uploads' },
  { command: 'trending',   description: '🔥 Popular Files' },
  { command: 'favorites',  description: '❤️ My Saved Files' },
  { command: 'myaccount',  description: '👤 Check Limit' },
  { command: 'help',       description: '📖 Help & Commands' },
]).catch(() => {});

bot.on('channel_post', async (msg) => {
  if (String(msg.chat.id) !== STORAGE_CHANNEL_ID_STR) return;
  const file = msg.video || msg.document;
  if (!file) return;

  try {
    if (await File.exists({ message_id: msg.message_id })) return;

    const rawName  = msg.caption || file.file_name || 'Unknown';
    const clean    = cleanFileName(rawName).slice(0, 200) || 'Untitled';
    const customId = await nextSequence();

    const res = await File.updateOne(
      { message_id: msg.message_id },
      {
        $setOnInsert: {
          customId,
          file_name:   rawName,
          type:        msg.video ? 'video' : 'document',
          file_size:   formatSize(file.file_size),
          clean_title: clean,
          attributes:  clean.toLowerCase().split(/\s+/).filter(Boolean),
          uploaded_at: new Date(),
          downloads: 0,
          weeklyDownloads: 0,
        }
      },
      { upsert: true, setDefaultsOnInsert: false }
    );
    if (res.upsertedCount !== 1) return;

    const badgeText = `\n\n✅ Indexed: ${customId}`;
    const room      = 1000 - badgeText.length;
    let baseCaption = Array.from(msg.caption || '');
    if (baseCaption.length > room) baseCaption = [...baseCaption.slice(0, room - 1), '…'];
    await bot.editMessageCaption(
      `${esc(baseCaption.join(''))}\n\n✅ <b>Indexed:</b> ${customId}`,
      { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML' }
    ).catch(e => {
      if (!/message is not modified/i.test(e.message || '')) console.warn(`Caption edit failed for ${customId}:`, e.message);
    });

  } catch (err) {
    if (err.code === 11000) return;
    console.error('Index Error:', err);
  }
});

function buildHelp() {
  return (
    `📚 <b>Help Guide</b>\n\n` +
    `🔎 <b>Search:</b> Just type the movie/show name.\n` +
    `   Supports <b>fuzzy search</b> – partial names work too!\n` +
    `❤️ <b>/favorites</b> – Save files for later (max ${FAV_LIMIT_NUM}).\n` +
    `🗑️ <b>/clearfavorites</b> – Remove all your saved favorites.\n` +
    `📊 <b>/trending</b> – See what's popular this week.\n` +
    `🆕 <b>/recent</b> – View Latest uploads.\n` +
    `👤 <b>/myaccount</b> – Your daily limit (${DAILY_LIMIT_NUM}/day).`
  );
}

command('start', async (msg, match) => {
  if (!msg.from) return;
  const chatId     = msg.chat.id;
  const fromId     = String(msg.from.id);
  const startParam = match[1]?.trim();

  await saveUser(msg, true);

  if (await isUserBanned(fromId)) {
    return bot.sendMessage(chatId, '🚫 <b>You have been banned from using this bot.</b>', { parse_mode: 'HTML' });
  }

  if (msg.chat.type !== 'private') {
    if (startParam) return;
    const sent = await bot.sendMessage(chatId,
      `👋 <b>Hello! I work in Private Chat.</b>\nClick below to start:`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🤖 Start Me', url: `https://t.me/${BOT_USERNAME}` }]] }
      });
    return scheduleDelete(bot, chatId, sent.message_id, 10000);
  }

  if (startParam && FILE_ID_RE.test(startParam)) {
    const customId = startParam.toUpperCase();
    if (!await verifyJoin(bot, chatId, fromId, customId)) return;
    return deliverFile(bot, chatId, fromId, customId);
  }

  if (!await verifyJoin(bot, chatId, fromId)) return;

  if (startParam?.toLowerCase() === 'help') {
    return bot.sendMessage(chatId, buildHelp(), { parse_mode: 'HTML' });
  }

  bot.sendMessage(chatId,
    `👋 <b>Welcome, ${esc(msg.from.first_name)}!</b>\n\n` +
    `🔎 <b>How to search:</b>\nSimply type the name of the movie.\n<i>Example: "Avengers" or "Breaking Bad"</i>\n\n` +
    `📂 Use /help for more details`,
    { parse_mode: 'HTML' }
  );
});

command('help', async (msg) => {
  if (msg.chat.type !== 'private') {
    const sent = await bot.sendMessage(msg.chat.id,
      `ℹ️ <b>Help:</b> Type a movie/show name to search.\nTap below for full commands.`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '📖 Full Help', url: `https://t.me/${BOT_USERNAME}?start=help` }]] }
      }).catch(() => null);
    if (sent) scheduleDelete(bot, msg.chat.id, sent.message_id, 30000);
    return;
  }
  bot.sendMessage(msg.chat.id, buildHelp(), { parse_mode: 'HTML' });
});

command('admin', async (msg) => {
  if (!isAdmin(msg)) return;
  bot.sendMessage(msg.chat.id,
    `👮‍♂️ <b>Admin Commands:</b>\n\n` +
    `/stats – Bot statistics\n` +
    `/broadcast – Message all users\n` +
    `/cancel – Cancel active broadcast\n` +
    `/delete [ID] – Remove a file\n` +
    `/ban [userId] – Ban a user\n` +
    `/unban [userId] – Unban a user`,
    { parse_mode: 'HTML' }
  );
});

command('trending', async (msg) => {
  const chatId  = msg.chat.id;
  const isGroup = msg.chat.type !== 'private';

  if (!await guard(msg)) return;
  if (isGroup && !checkAndSetGroupCooldown(chatId)) return;

  await resetTrendingIfNewWeek();

  const files = await File.find({ weeklyDownloads: { $gt: 0 } })
    .select('customId clean_title file_size weeklyDownloads')
    .sort({ weeklyDownloads: -1 })
    .limit(TRENDING_LIMIT_NUM)
    .lean();

  if (!files.length) {
    const sent = await bot.sendMessage(chatId, 'No trending files this week yet.');
    return scheduleDelete(bot, chatId, sent.message_id, 5000);
  }

  const header   = '📈 <b>Top Trending This Week:</b>';
  const keyboard = isGroup
    ? files.map(f => [{ text: `📥 ${f.file_size} | ${f.clean_title}`, url: `https://t.me/${BOT_USERNAME}?start=${f.customId}` }])
    : files.map(f => [{ text: `🔥 ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);

  const sent = await bot.sendMessage(chatId, header, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
  }).catch(() => null);
  if (sent) scheduleDelete(bot, chatId, sent.message_id, isGroup ? GROUP_DELETE_TIME : PRIVATE_DELETE_TIME);
});

command('recent', async (msg) => {
  const chatId  = msg.chat.id;
  const isGroup = msg.chat.type !== 'private';

  if (!await guard(msg)) return;
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

  const header   = '🆕 <b>Recent Uploads:</b>';
  const keyboard = isGroup
    ? files.map(f => [{ text: `🆕 ${f.file_size} | ${f.clean_title}`, url: `https://t.me/${BOT_USERNAME}?start=${f.customId}` }])
    : files.map(f => [{ text: `📂 ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);

  const sent = await bot.sendMessage(chatId, header, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
  }).catch(() => null);
  if (sent) scheduleDelete(bot, chatId, sent.message_id, isGroup ? GROUP_DELETE_TIME : PRIVATE_DELETE_TIME);
});

command('favorites', async (msg) => {
  if (msg.chat.type !== 'private') return privateOnlyReply(msg.chat.id);
  if (!await guard(msg)) return;

  const userId = String(msg.from.id);
  const favs   = await Favorite.find({ userId }).sort({ savedAt: -1 }).select('customId').lean();

  if (!favs.length) {
    const sent = await bot.sendMessage(msg.chat.id, '❤️ No favorites saved yet. Press the button on any file to save it!');
    return scheduleDelete(bot, msg.chat.id, sent.message_id, 8000);
  }

  const allFavIds = favs.map(f => f.customId);
  const total     = allFavIds.length;
  const files     = await fetchFilesInOrder(allFavIds.slice(0, RESULTS_PER_PAGE_NUM));
  const keyboard  = files.map(f => [{ text: `⭐ ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);

  const totalPages = Math.ceil(total / RESULTS_PER_PAGE_NUM);
  if (total > RESULTS_PER_PAGE_NUM) {
    const favSearchId = cacheSearchResults(userId, allFavIds, 'fav');
    keyboard.push([{ text: `Page 1 of ${totalPages} ➡️`, callback_data: `PAGE_FAV:1:${favSearchId}` }]);
  }

  const headerText = total > RESULTS_PER_PAGE_NUM
    ? `❤️ <b>Your Favorites (${total}/${FAV_LIMIT_NUM}):</b>\n<i>Page 1 of ${totalPages}</i>`
    : `❤️ <b>Your Favorites (${total}/${FAV_LIMIT_NUM}):</b>`;
  const sent = await bot.sendMessage(msg.chat.id, headerText,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
  );
  scheduleDelete(bot, msg.chat.id, sent.message_id, PRIVATE_DELETE_TIME);
});

command('clearfavorites', async (msg) => {
  if (msg.chat.type !== 'private') return privateOnlyReply(msg.chat.id);
  if (!await guard(msg, { join: false })) return;

  const userId = String(msg.from.id);
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

command('myaccount', async (msg) => {
  if (msg.chat.type !== 'private') return privateOnlyReply(msg.chat.id);
  if (!await guard(msg)) return;

  const used = await getUserLimitCount(String(msg.from.id));
  const sent = await bot.sendMessage(msg.chat.id,
    `👤 <b>Account</b>\nUsed Today: <b>${used}/${DAILY_LIMIT_NUM}</b>\n✅ Limit resets daily at midnight UTC`,
    { parse_mode: 'HTML' }
  );
  scheduleDelete(bot, msg.chat.id, sent.message_id, PRIVATE_DELETE_TIME);
});

command('stats', async (msg) => {
  if (!isAdmin(msg)) return;

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

command('cancel', async (msg) => {
  if (!isAdmin(msg)) return;
  if (!broadcastActive) return bot.sendMessage(msg.chat.id, 'ℹ️ No broadcast is currently running.');
  broadcastAbort = true;
  bot.sendMessage(msg.chat.id, '🛑 Broadcast cancellation requested.');
});

command('broadcast', async (msg, match) => {
  if (!isAdmin(msg)) return;

  const chatId   = msg.chat.id;
  const text     = match[1];
  const replyMsg = msg.reply_to_message;

  if (!text && !replyMsg) {
    return bot.sendMessage(chatId,
      '⚠️ <b>Usage:</b>\n1. <code>/broadcast Your message</code>\n2. Reply to any message with <code>/broadcast</code>',
      { parse_mode: 'HTML' }
    );
  }

  if (broadcastActive) {
    return bot.sendMessage(chatId, '⚠️ A broadcast is already running. Use /cancel to stop it first.');
  }
  broadcastActive = true;
  broadcastAbort  = false;

  let total = 0, success = 0, blocked = 0, failed = 0;
  let plainText = false;
  let statusMsg = null;

  async function sendToUser(userId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (replyMsg) await bot.copyMessage(userId, chatId, replyMsg.message_id);
        else await bot.sendMessage(userId, text, plainText ? {} : { parse_mode: 'HTML' });
        success++;
        return;
      } catch (err) {
        const status = err.response?.statusCode;
        const desc   = err.response?.body?.description || err.message || '';
        if (status === 429) {
          const retryAfter = Math.min(err.response?.body?.parameters?.retry_after ?? 5, 60);
          await sleep(retryAfter * 1000);
          continue;
        }
        if (!plainText && !replyMsg && /can't parse entities/i.test(desc)) { plainText = true; continue; }
        if (status === 403 || /chat not found|user is deactivated/i.test(desc)) {
          blocked++;
          User.updateOne({ userId }, { $set: { isInactive: true } }).catch(() => {});
          return;
        }
        failed++;
        return;
      }
    }
    failed++;
  }

  try {
    statusMsg = await bot.sendMessage(chatId, `🚀 Broadcast started…`);
    const cursor = User.find({ isBanned: { $ne: true }, isInactive: { $ne: true } }, { userId: 1 }).lean().cursor();
    for await (const user of cursor) {
      if (broadcastAbort || shuttingDown) break;
      await sendToUser(user.userId);
      total++;
      await sleep(50);
    }
  } catch (broadcastErr) {
    console.error('Broadcast error:', broadcastErr);
  } finally {
    broadcastActive = false;
  }

  const status = (broadcastAbort || shuttingDown) ? '🛑 Broadcast cancelled' : '✅ Broadcast complete';
  const summary =
    `${status}\n\n📤 Sent: <b>${success}</b>\n🚫 Blocked/Inactive: <b>${blocked}</b>\n` +
    `⚠️ Failed: <b>${failed}</b>\n👥 Attempted: <b>${total}</b>`;
  if (statusMsg) {
    bot.editMessageText(summary, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' })
      .catch(() => bot.sendMessage(chatId, summary, { parse_mode: 'HTML' }).catch(() => {}));
  } else {
    bot.sendMessage(chatId, summary, { parse_mode: 'HTML' }).catch(() => {});
  }
});

command('delete', async (msg, match) => {
  if (!isAdmin(msg)) return;

  const customId = (match[1] || '').trim().toUpperCase();
  if (!FILE_ID_RE.test(customId)) {
    return bot.sendMessage(msg.chat.id, '⚠️ Usage: <code>/delete F0001</code>', { parse_mode: 'HTML' });
  }

  const result = await File.deleteOne({ customId });
  if (result.deletedCount > 0) await Favorite.deleteMany({ customId }).catch(() => {});

  bot.sendMessage(msg.chat.id,
    result.deletedCount > 0
      ? `🗑️ <b>Deleted:</b> File <code>${customId}</code> has been removed.`
      : `❌ <b>Not found:</b> <code>${customId}</code>`,
    { parse_mode: 'HTML' }
  );
});

async function setBan(msg, match, banned) {
  if (!isAdmin(msg)) return;
  const targetId = (match[1] || '').trim();
  if (!/^\d+$/.test(targetId)) {
    return bot.sendMessage(msg.chat.id, `⚠️ Usage: <code>/${banned ? 'ban' : 'unban'} 123456789</code>`, { parse_mode: 'HTML' });
  }
  if (banned && ADMIN_SET.has(targetId)) {
    return bot.sendMessage(msg.chat.id, `⚠️ You can't ban an admin.`);
  }

  const result = await User.findOneAndUpdate({ userId: targetId }, { isBanned: banned }, { new: true });
  if (result) {
    invalidateBanCache(targetId);
    bot.sendMessage(msg.chat.id,
      banned ? `🚫 <b>User <code>${targetId}</code> has been banned.</b>` : `✅ <b>User <code>${targetId}</code> has been unbanned.</b>`,
      { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(msg.chat.id, `❌ User <code>${targetId}</code> not found in database.`, { parse_mode: 'HTML' });
  }
}
command('ban',   (msg, match) => setBan(msg, match, true));
command('unban', (msg, match) => setBan(msg, match, false));

async function handleMessage(msg) {
  if (msg.new_chat_members?.some(m => m.id === BOT_ME.id)) {
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

  if (!msg.text || msg.text.startsWith('/') || !msg.from || msg.from.is_bot || msg.chat.type === 'channel') return;

  const chatId  = msg.chat.id;
  const fromId  = String(msg.from.id);
  const isGroup = msg.chat.type !== 'private';
  const text    = msg.text.trim();

  if (text.length < 3) return;

  if (await isUserBanned(fromId)) return;

  if (isGroup) {
    if (!checkAndSetGroupCooldown(chatId)) return;

    const { files: allMatches, isFuzzy } = await searchFiles(text, 100);

    if (allMatches.length > 0) {
      const gTotal        = allMatches.length;
      const groupSearchId = cacheSearchResults(fromId, allMatches.map(f => f.customId), 'group');
      const gFiles        = allMatches.slice(0, RESULTS_PER_PAGE_NUM);

      const header   = isFuzzy
        ? `🔍 <b>Fuzzy results for "${esc(text)}" (${gTotal} total):</b>`
        : `🔍 <b>Found ${gTotal} result(s):</b>`;
      const keyboard = gFiles.map(f => [{
        text: formatSearchBtn(f),
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
        `🤷‍♂️ <b>Could not find "${esc(text)}"</b>\nTry checking the spelling.`,
        { parse_mode: 'HTML' }
      ).catch(() => null);
      if (sent) scheduleDelete(bot, chatId, sent.message_id, NO_RESULT_DELETE_TIME);
    }
    return;
  }

  await saveUser(msg);
  if (!await verifyJoin(bot, chatId, fromId)) return;

  try {
    const { files: allMatches, isFuzzy } = await searchFiles(text, 100);

    if (!allMatches.length) {
      const sent = await bot.sendMessage(chatId,
        `🔍 <b>No results for "${esc(text)}".</b>\nTry different keywords or check spelling.`,
        { parse_mode: 'HTML' }
      );
      return scheduleDelete(bot, chatId, sent.message_id, NO_RESULT_DELETE_TIME);
    }

    const total    = allMatches.length;
    const searchId = cacheSearchResults(fromId, allMatches.map(f => f.customId), 'search');
    const files    = allMatches.slice(0, RESULTS_PER_PAGE_NUM);

    const header   = isFuzzy
      ? `🔍 Found <b>${total}</b> fuzzy match(es) for "<i>${esc(text)}</i>":`
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
}

bot.on('message', (msg) => {
  handleMessage(msg).catch(err => console.error('Message handler error:', err));
});

const PAGE_KINDS = { PAGE: 'search', PAGE_G: 'group', PAGE_FAV: 'fav' };

async function handlePagination(q, prefix, page, searchId) {
  const chatId = q.message.chat.id;
  const fromId = String(q.from.id);
  const kind   = PAGE_KINDS[prefix];

  const { status, ids, total } = getCachedPage(searchId, page, fromId, kind);
  if (status === 'forbidden') {
    return bot.answerCallbackQuery(q.id, { text: 'This list belongs to someone else — run your own search.', show_alert: true });
  }
  if (status !== 'ok' || !ids.length) {
    return bot.answerCallbackQuery(q.id, {
      text: kind === 'fav' ? 'Session expired. Please run /favorites again.' : 'Search expired. Please search again.'
    });
  }

  const files = await fetchFilesInOrder(ids);
  const keyboard = files.map(f => {
    if (kind === 'group') return [{ text: formatSearchBtn(f), url: `https://t.me/${BOT_USERNAME}?start=${f.customId}` }];
    if (kind === 'fav')   return [{ text: `⭐ ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }];
    return [{ text: formatSearchBtn(f), callback_data: `GET:${f.customId}` }];
  });

  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `${prefix}:${page - 1}:${searchId}` });
  if ((page + 1) * RESULTS_PER_PAGE_NUM < total) nav.push({ text: 'Next ➡️', callback_data: `${prefix}:${page + 1}:${searchId}` });
  if (nav.length) keyboard.push(nav);

  const totalPages = Math.ceil(total / RESULTS_PER_PAGE_NUM);
  let header;
  if (kind === 'fav') {
    const freshTotal = await Favorite.countDocuments({ userId: fromId });
    header = `❤️ <b>Your Favorites (${freshTotal}/${FAV_LIMIT_NUM}):</b>\n<i>Page ${page + 1} of ${totalPages}</i>`;
  } else {
    header = `🔍 Results — Page <b>${page + 1}</b> of <b>${totalPages}</b>`;
  }

  await safeEdit(header, {
    chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
  await bot.answerCallbackQuery(q.id);
}

async function handleCallback(q) {
  const data = q.data;
  if (!q.message || typeof data !== 'string' || data.length > 64) return bot.answerCallbackQuery(q.id);

  const chatId    = q.message.chat.id;
  const isPrivate = q.message.chat.type === 'private';
  const fromId    = String(q.from.id);

  if (await isUserBanned(fromId)) {
    return bot.answerCallbackQuery(q.id, { text: '🚫 You are banned.', show_alert: true });
  }

  let m;

  if ((m = /^CHECK_JOIN(?::(F\d{4,}))?$/i.exec(data))) {
    const fileCode = m[1] ? m[1].toUpperCase() : null;
    clearMemberCacheEntry(fromId);

    if (await verifyJoin(bot, chatId, fromId, fileCode, { quiet: true })) {
      bot.answerCallbackQuery(q.id, { text: '✅ Verified!' });
      bot.deleteMessage(chatId, q.message.message_id).catch(() => {});
      if (fileCode) return deliverFile(bot, chatId, fromId, fileCode);
      await bot.sendMessage(chatId, '✅ Thanks! You can now search for files.');
    } else {
      await bot.answerCallbackQuery(q.id, { text: '❌ Not verified yet. Join the channel, then try again.', show_alert: true });
    }
    return;
  }

  if (!await verifyJoin(bot, chatId, fromId, null, { quiet: !isPrivate })) {
    return bot.answerCallbackQuery(q.id, { text: 'Please join the channel first!', show_alert: true });
  }

  if ((m = /^(PAGE|PAGE_G|PAGE_FAV):(\d{1,4}):([A-Za-z0-9_-]{6,32})$/.exec(data))) {
    return handlePagination(q, m[1], Number(m[2]), m[3]);
  }

  if ((m = /^GET:(F\d{4,})$/.exec(data))) {
    bot.answerCallbackQuery(q.id, { text: '📤 Sending file...' });
    return deliverFile(bot, chatId, fromId, m[1]);
  }

  if ((m = /^FAV:(F\d{4,})$/.exec(data))) {
    const customId = m[1];
    const exists   = await Favorite.findOne({ userId: fromId, customId }).select('_id').lean();

    if (exists) {
      await Favorite.deleteOne({ userId: fromId, customId });
      return bot.answerCallbackQuery(q.id, { text: '💔 Removed from favorites.' });
    }

    if (!await File.exists({ customId })) {
      return bot.answerCallbackQuery(q.id, { text: '❌ That file no longer exists.', show_alert: true });
    }
    if (await Favorite.countDocuments({ userId: fromId }) >= FAV_LIMIT_NUM) {
      return bot.answerCallbackQuery(q.id, {
        text: `❌ Max ${FAV_LIMIT_NUM} favorites allowed. Remove one first.`, show_alert: true
      });
    }
    try {
      await Favorite.create({ userId: fromId, customId });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
    if (await Favorite.countDocuments({ userId: fromId }) > FAV_LIMIT_NUM) {
      await Favorite.deleteOne({ userId: fromId, customId });
      return bot.answerCallbackQuery(q.id, { text: `❌ Max ${FAV_LIMIT_NUM} favorites allowed.`, show_alert: true });
    }
    return bot.answerCallbackQuery(q.id, { text: '❤️ Saved to favorites!' });
  }

  return bot.answerCallbackQuery(q.id);
}

bot.on('callback_query', async (q) => {
  try {
    await handleCallback(q);
  } catch (e) {
    console.error('Callback Error:', e);
    await bot.answerCallbackQuery(q.id, { text: '⚠️ Something went wrong. Please try again.' });
  }
});

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down gracefully...`);

  setTimeout(() => { console.error('Forced exit after shutdown timeout'); process.exit(exitCode || 1); }, 15000).unref();

  try {
    broadcastAbort = true;
    for (const t of intervals) clearInterval(t);
    for (const t of pendingDeletions.values()) clearTimeout(t);
    pendingDeletions.clear();

    if (server) {
      await Promise.race([
        new Promise(res => server.close(() => res())),
        sleep(5000),
      ]);
      server.closeIdleConnections?.();
    }

    const deadline = Date.now() + 5000;
    while (broadcastActive && Date.now() < deadline) await sleep(100);

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error during shutdown:', err.message);
    exitCode = exitCode || 1;
  }
  process.exit(exitCode);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await withRetry(
    () => bot.setWebHook(`${RENDER_EXTERNAL_URL}${WEBHOOK_PATH}`, {
      secret_token: WEBHOOK_SECRET,
      allowed_updates: JSON.stringify(['message', 'callback_query', 'channel_post']),
      max_connections: 40,
    }),
    { attempts: 5, label: 'setWebHook' }
  );
  console.log('✅ Webhook registered');
} catch (err) {
  console.error('❌ Failed to register webhook:', err.message);
  shutdown('webhook-registration-failed', 1);
}
