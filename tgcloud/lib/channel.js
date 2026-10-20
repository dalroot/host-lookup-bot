import { sql } from 'sdk/db';
import { fsubChannels, botSettings } from '../schema.js';

/**
 * Ensure default Dall channel is seeded if table is empty
 */
export async function ensureDefaultChannel(db) {
  try {
    const countRes = await db.get(sql`SELECT count(*) as count FROM fsub_channels`);
    if (!countRes || countRes.count === 0) {
      await db.insert(fsubChannels).values({
        chatId: '-1004358353828',
        title: 'دال | Dall',
        inviteLink: 'https://t.me/+hbqGe6obpXwxMTQ5',
        isActive: true,
      });
    }
    // Clean up duplicate entries if any
    try {
      await db.run(sql`DELETE FROM fsub_channels WHERE id NOT IN (SELECT MIN(id) FROM fsub_channels GROUP BY chat_id)`);
    } catch {}
  } catch (err) {
    console.error('ensureDefaultChannel error:', err);
  }
}

/**
 * Fetch all active channels from database (auto-seeds default if empty)
 */
export async function getActiveChannels(db) {
  try {
    await ensureDefaultChannel(db);
    return await db.all(sql`SELECT * FROM fsub_channels WHERE is_active = true`);
  } catch (err) {
    console.error('Error in getActiveChannels:', err);
    return [];
  }
}

/**
 * Check if a user is a member of all active channels
 */
export async function checkAllChannels(api, db, userId) {
  if (!userId) {
    return { passed: true, missing: [] };
  }

  const activeList = await getActiveChannels(db);
  if (!activeList || activeList.length === 0) {
    return { passed: true, missing: [] };
  }

  // Deduplicate channels by chat_id
  const seenChats = new Set();
  const uniqueChannels = [];
  for (const ch of activeList) {
    const cid = String(ch.chat_id || ch.chatId);
    if (!seenChats.has(cid)) {
      seenChats.add(cid);
      uniqueChannels.push(ch);
    }
  }

  const missing = [];
  for (const ch of uniqueChannels) {
    const cid = ch.chat_id || ch.chatId;
    try {
      const member = await api.getChatMember({
        chat_id: cid,
        user_id: userId,
      });
      console.log(`[fsub-debug] user ${userId} in ${cid}: status=${member?.status}`, JSON.stringify(member));
      const status = member?.status;
      // Valid statuses for a joined user in Telegram
      if (!['creator', 'administrator', 'member', 'restricted'].includes(status)) {
        missing.push(ch);
      }
    } catch (err) {
      const errStr = (err?.message || String(err)).toLowerCase();
      // Telegram throws "Bad Request: member not found" / "USER_NOT_PARTICIPANT" when user is NOT in channel
      if (
        errStr.includes('member not found') ||
        errStr.includes('user not found') ||
        errStr.includes('user_not_participant') ||
        errStr.includes('not participant') ||
        errStr.includes('participant_id_invalid')
      ) {
        missing.push(ch);
      } else {
        console.error(`Error checking membership for channel ${cid}:`, err);
        // Only if bot is not admin in the channel or chat not found, do not block regular users
      }
    }
  }

  return {
    passed: missing.length === 0,
    missing,
  };
}

/**
 * Render stylish join prompt with individual buttons for each missing channel
 */
export function formatJoinPrompt(missingChannels, lang = 'en') {
  const isFa = lang === 'fa';
  let text = isFa
    ? `<blockquote>📢 <b>عضویت در کانال رسمی الزامی است</b></blockquote>\n\n` +
      `کاربر گرامی؛ برای استفاده از خدمات رایگان و پرسرعت ربات <b>Host Lookup</b>، لطفاً ابتدا در کانال‌های زیر عضو شوید:\n\n`
    : `<blockquote>📢 <b>Official Channel Membership Required</b></blockquote>\n\n` +
      `To use the free and high-speed features of <b>Host Lookup</b>, please join our official channel(s) first:\n\n`;

  const buttons = [];
  for (const ch of missingChannels) {
    const title = ch.title || (isFa ? 'کانال رسمی' : 'Official Channel');
    const link = ch.invite_link || ch.inviteLink;
    text += `👉 <b>${title}</b>\n`;
    buttons.push([{ text: isFa ? `📢 عضویت در ${title} ↗️` : `📢 Join ${title} ↗️`, url: link }]);
  }

  text += isFa
    ? `\n<i>پس از عضویت، روی دکمه زیر کلیک کنید:</i>`
    : `\n<i>After joining, click the button below to verify:</i>`;
  buttons.push([{ text: isFa ? '🔄 تایید عضویت (بررسی مجدد)' : '🔄 Verify Membership', callback_data: 'check_fsub' }]);

  return {
    text,
    reply_markup: { inline_keyboard: buttons },
  };
}

/**
 * Admin step state management
 */
export async function getAdminStep(db) {
  try {
    await db.run(sql`CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)`);
    const row = await db.get(sql`SELECT value FROM bot_settings WHERE key = 'admin_step'`);
    return row?.value || null;
  } catch (err) {
    console.error('getAdminStep error:', err);
    return null;
  }
}

export async function setAdminStep(db, step) {
  try {
    await db.run(sql`CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)`);
    if (!step) {
      await db.run(sql`DELETE FROM bot_settings WHERE key = 'admin_step'`);
    } else {
      await db.run(sql`INSERT INTO bot_settings (key, value) VALUES ('admin_step', ${step}) ON CONFLICT(key) DO UPDATE SET value = ${step}`);
    }
  } catch (err) {
    console.error('setAdminStep error:', err);
  }
}

/**
 * Automatically detect channel information from forwarded message or text input
 */
export async function autoDetectChannel(api, message, rawText) {
  let targetChatId = null;
  let title = null;
  let username = null;
  let inviteLink = null;

  // 1. Check if forwarded from channel (Bot API 7.0+ MessageOriginChannel)
  if (message.forward_origin && message.forward_origin.type === 'channel' && message.forward_origin.chat) {
    const chat = message.forward_origin.chat;
    targetChatId = chat.id;
    title = chat.title;
    username = chat.username;
  }
  // Bot API classic forward_from_chat
  else if (message.forward_from_chat && (message.forward_from_chat.type === 'channel' || message.forward_from_chat.type === 'supergroup')) {
    targetChatId = message.forward_from_chat.id;
    title = message.forward_from_chat.title;
    username = message.forward_from_chat.username;
  }
  // 2. Check if raw text looks like @username or -100... or t.me link
  else if (rawText) {
    let clean = rawText.trim();
    if (clean.includes('t.me/')) {
      const match = clean.match(/t\.me\/([a-zA-Z0-9_+]+)/);
      if (match && match[1]) {
        if (match[1].startsWith('+')) {
          inviteLink = clean;
        } else {
          clean = '@' + match[1];
        }
      }
    }
    if (clean.startsWith('@') || /^-?100\d+$/.test(clean)) {
      try {
        const chat = await api.getChat({ chat_id: clean });
        if (chat) {
          targetChatId = chat.id;
          title = chat.title;
          username = chat.username;
          inviteLink = chat.invite_link || inviteLink;
        }
      } catch (err) {
        console.error('getChat error:', err);
      }
    }
  }

  return { targetChatId, title, username, inviteLink };
}

/**
 * Verify if the bot is an administrator in the target channel
 */
export async function verifyBotIsAdmin(api, chatId) {
  try {
    const me = await api.getMe();
    const member = await api.getChatMember({ chat_id: chatId, user_id: me.id });
    const isAdmin = ['administrator', 'creator'].includes(member?.status);
    return { ok: isAdmin, bot: me, member };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Generate or retrieve an invite link for a channel
 */
export async function getOrCreateInviteLink(api, chatId, username, existingLink) {
  if (existingLink && existingLink.startsWith('http')) return existingLink;
  if (username) return `https://t.me/${username}`;
  try {
    const res = await api.createChatInviteLink({ chat_id: chatId, name: 'HostLookupBot Force-Join' });
    if (res?.invite_link) return res.invite_link;
  } catch (err) {
    console.error('createChatInviteLink error:', err);
  }
  return `https://t.me/c/${String(chatId).replace('-100', '')}`;
}
