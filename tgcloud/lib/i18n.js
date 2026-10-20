import { sql } from 'sdk/db';
import { botSettings } from '../schema.js';

/**
 * Retrieve user preferred language ('en' | 'fa')
 * Defaults to 'en'
 */
export async function getUserLang(db, tgId) {
  if (!tgId) return 'en';
  try {
    await db.run(sql`CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)`);
    const row = await db.get(sql`SELECT value FROM bot_settings WHERE key = ${`lang_${tgId}`}`);
    return row?.value || 'en';
  } catch (err) {
    console.error('getUserLang error:', err);
    return 'en';
  }
}

/**
 * Save user preferred language ('en' | 'fa')
 */
export async function setUserLang(db, tgId, lang) {
  if (!tgId) return;
  const safeLang = lang === 'fa' ? 'fa' : 'en';
  try {
    await db.run(sql`CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)`);
    await db.run(
      sql`INSERT INTO bot_settings (key, value) VALUES (${`lang_${tgId}`}, ${safeLang}) ON CONFLICT(key) DO UPDATE SET value = ${safeLang}`
    );
  } catch (err) {
    console.error('setUserLang error:', err);
  }
}

/**
 * Generate language selection card & keyboard
 */
export function getLanguageCard(currentLang = 'en') {
  const isFa = currentLang === 'fa';
  const text =
    `<blockquote>🌐 <b>Language Settings / تنظیمات زبان</b></blockquote>\n\n` +
    `• Current: <b>${isFa ? '🇮🇷 فارسی (Persian)' : '🇬🇧 English'}</b>\n\n` +
    `Please select your preferred language:\n` +
    `لطفاً زبان مورد نظر خود را انتخاب فرمایید:`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: `${currentLang === 'en' ? '✅ ' : ''}🇬🇧 English`, callback_data: 'set_lang_en' },
        { text: `${currentLang === 'fa' ? '✅ ' : ''}🇮🇷 فارسی`, callback_data: 'set_lang_fa' },
      ],
      [
        { text: isFa ? '🏠 منوی اصلی' : '🏠 Main Menu', callback_data: 'menu_main' },
      ],
    ],
  };

  return { text, reply_markup: keyboard };
}

/**
 * Card displayed after changing language
 */
export function getLanguageSuccessCard(newLang = 'en') {
  if (newLang === 'fa') {
    return {
      text:
        `<blockquote>🌐 <b>تنظیمات زبان به‌روزرسانی شد</b></blockquote>\n\n` +
        `زبان ربات با موفقیت روی <b>فارسی 🇮🇷</b> تنظیم شد.\n\n` +
        `<i>هر زمان که بخواهید می‌توانید با ارسال دستور /language زبان را تغییر دهید.</i>`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔍 استعلام جدید (Search)', switch_inline_query_current_chat: '' },
            { text: '⚡️ تست سرور 1.1.1.1', callback_data: 'wip_1.1.1.1' },
          ],
          [
            { text: '🌐 تغییر مجدد زبان', callback_data: 'menu_language' },
            { text: '🏠 منوی اصلی', callback_data: 'menu_main' },
          ],
        ],
      },
    };
  }

  return {
    text:
      `<blockquote>🌐 <b>Language Settings Updated</b></blockquote>\n\n` +
      `Your language preference has been set to <b>English 🇬🇧</b>.\n\n` +
      `<i>You can change your language anytime by sending /language.</i>`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔍 Fast Inline Search', switch_inline_query_current_chat: '' },
          { text: '⚡️ Test with 1.1.1.1', callback_data: 'wip_1.1.1.1' },
        ],
        [
          { text: '🌐 Change Language', callback_data: 'menu_language' },
          { text: '🏠 Main Menu', callback_data: 'menu_main' },
        ],
      ],
    },
  };
}
