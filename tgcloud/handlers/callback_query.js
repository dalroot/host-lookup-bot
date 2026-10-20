import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { users, fsubChannels } from '../schema.js';
import {
  cleanHost,
  isIpAddress,
  lookupIp,
  lookupDomain,
  resolveDomainIp,
  resolveAllDns,
  formatIpCard,
  formatUnifiedCard,
  formatDnsCard,
  formatWelcomeCard,
  escapeHtml,
} from '../lib/whois.js';
import {
  checkLiveness,
  runMultiPingCheck,
  formatMultiPingCard,
} from '../lib/checkhost.js';
import {
  checkAllChannels,
  formatJoinPrompt,
  ensureDefaultChannel,
  getAdminStep,
  setAdminStep,
} from '../lib/channel.js';
import {
  getUserLang,
  setUserLang,
  getLanguageCard,
  getLanguageSuccessCard,
} from '../lib/i18n.js';

export const ADMIN_ID = 8629398713;

export default async function (query, ctx) {
  const data = query.data || '';
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const fromUserId = query.from?.id;

  // Fast acknowledge for normal buttons (if not handled specifically)
  if (!data.startsWith('wping_') && !data.startsWith('admin_bc_send_')) {
    api.answerCallbackQuery({ callback_query_id: query.id }).catch(() => {});
  }

  const backButton = [
    [
      { text: '🔍 New Lookup', switch_inline_query_current_chat: '' },
      { text: '🏠 Main Menu', callback_data: 'menu_main' },
    ],
  ];

  // ==========================================
  // 0. CHECK MANDATORY JOIN (IN-PLACE RE-VERIFICATION)
  // ==========================================
  if (data === 'check_fsub') {
    const userLang = await getUserLang(db, fromUserId);
    const isFa = userLang === 'fa';
    const check = await checkAllChannels(api, db, fromUserId);
    if (!check.passed) {
      api.answerCallbackQuery({
        callback_query_id: query.id,
        text: isFa ? '⚠️ هنوز در تمام کانال‌ها عضو نشده‌اید!' : '⚠️ You have not joined all required channels yet!',
        show_alert: true,
      }).catch(() => {});

      const prompt = formatJoinPrompt(check.missing, userLang);
      try {
        return await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: prompt.text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: prompt.reply_markup,
        });
      } catch {}
      return;
    }

    api.answerCallbackQuery({
      callback_query_id: query.id,
      text: isFa ? '✅ عضویت شما تایید شد! ربات فعال و آماده است.' : '✅ Membership confirmed! Bot is ready to use.',
      show_alert: false,
    }).catch(() => {});

    // Fetch live sample lookup for 1.1.1.1 to demonstrate bot is fully active
    const demoIp = await lookupIp('1.1.1.1');
    const demoCard = formatIpCard(demoIp);

    const confirmedText = isFa
      ? `<blockquote>✅ <b>عضویت شما تایید شد — ربات فعال و آماده خدمات است!</b></blockquote>\n\n` +
        `🎉 با تشکر از عضویت شما در کانال رسمی، تمامی قابلیت‌های ربات <b>Host Lookup</b> فعال گردید.\n\n` +
        `👇 <b>نمونه استعلام زنده سرور (Cloudflare 1.1.1.1):</b>\n\n` +
        demoCard
      : `<blockquote>✅ <b>Membership Verified — Bot is Ready!</b></blockquote>\n\n` +
        `🎉 Thank you for joining our official channel. All <b>Host Lookup</b> features are now unlocked and active.\n\n` +
        `👇 <b>Live Sample Server Intelligence (Cloudflare 1.1.1.1):</b>\n\n` +
        demoCard;

    const keyboard = {
      inline_keyboard: [
        [
          { text: isFa ? '🔍 استعلام جدید (Search)' : '🔍 Fast Inline Search', switch_inline_query_current_chat: '' },
          { text: isFa ? '⚡️ تست سرور 1.1.1.1' : '⚡️ Test Ping 1.1.1.1', callback_data: 'wping_1.1.1.1' },
        ],
        [
          { text: '🌐 Language / زبان', callback_data: 'menu_language' },
          { text: '🐙 Open Source on GitHub ↗️', url: 'https://github.com/dalroot/host-lookup-bot' },
        ],
      ],
    };

    try {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: confirmedText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
    } catch {}
    return;
  }

  // ==========================================
  // 1. ADMIN ACTIONS (DASHBOARD, CHANNELS, BROADCAST, USERS)
  // ==========================================
  if (fromUserId === ADMIN_ID) {
    // 1.1. Admin Dashboard & Refresh Stats
    if (data === 'admin_panel' || data === 'admin_refresh_stats') {
      await ensureDefaultChannel(db);
      let totalUsers = 0;
      let activeChannels = 0;
      try {
        const u = await db.get(sql`SELECT count(*) as count FROM users`);
        totalUsers = u?.count || 0;
        const c = await db.get(sql`SELECT count(*) as count FROM fsub_channels WHERE is_active = true`);
        activeChannels = c?.count || 0;
      } catch {}

      const now = new Date();
      const timeStr = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

      api.answerCallbackQuery({
        callback_query_id: query.id,
        text: `🔄 Statistics updated! (${totalUsers} users | ${timeStr})`,
        show_alert: false,
      }).catch(() => {});

      const panelText =
        `<blockquote>⚙️ <b>Host Lookup Admin Dashboard</b></blockquote>\n\n` +
        `📊 <b>Live Database Statistics:</b>\n` +
        `• 👥 <b>Total Users:</b> <code>${totalUsers}</code> users\n` +
        `• 📢 <b>Force-Join Channels:</b> <code>${activeChannels}</code> active\n` +
        `• 🕒 <b>Last Check:</b> <code>${timeStr}</code>\n\n` +
        `<i>Select an option below to manage the bot:</i>`;

      const panelKeyboard = {
        inline_keyboard: [
          [
            { text: '📢 Manage Channels', callback_data: 'admin_fsub' },
            { text: '➕ Add Channel', callback_data: 'admin_add_channel_prompt' },
          ],
          [
            { text: '📢 Broadcast Message', callback_data: 'admin_bc_prompt' },
            { text: '👥 User List', callback_data: 'admin_user_list' },
          ],
          [
            { text: '🔄 Refresh Statistics', callback_data: 'admin_refresh_stats' },
          ],
        ],
      };

      try {
        return await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: panelText,
          parse_mode: 'HTML',
          reply_markup: panelKeyboard,
        });
      } catch {}
      return;
    }

    // 1.2. Channels Management
    if (data === 'admin_fsub') {
      await ensureDefaultChannel(db);
      try {
        const list = await db.all(sql`SELECT * FROM fsub_channels ORDER BY id ASC`);
        let resp = `<blockquote>📢 <b>Force-Join Channels Management (${list?.length || 0}):</b></blockquote>\n\n`;
        const buttons = [];

        if (!list || list.length === 0) {
          resp += `<i>No channels registered in database.</i>\n`;
        } else {
          for (const ch of list) {
            const statusIcon = ch.is_active ? '🟢 Active' : '⚪️ Inactive';
            resp += `<b>#${ch.id}</b> | <b>${escapeHtml(ch.title || 'Channel')}</b> (${statusIcon})\n`;
            resp += `• <b>Chat ID:</b> <code>${ch.chat_id}</code>\n`;
            resp += `• <b>Link:</b> <a href="${ch.invite_link}">${ch.invite_link}</a>\n\n`;
            buttons.push([
              { text: `❌ Delete #${ch.id} (${ch.title || ch.chat_id})`, callback_data: `admin_del_${ch.id}` }
            ]);
          }
        }
        buttons.push([
          { text: '➕ Add Channel', callback_data: 'admin_add_channel_prompt' },
          { text: '🔙 Back to Dashboard', callback_data: 'admin_panel' }
        ]);

        return await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: resp,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: buttons },
        });
      } catch {}
      return;
    }

    // 1.3. Prompt Add Channel
    if (data === 'admin_add_channel_prompt') {
      await setAdminStep(db, 'awaiting_channel');
      const text =
        `<blockquote>➕ <b>Add Channel to Force-Join (Automatic)</b></blockquote>\n\n` +
        `Follow these 2 simple steps:\n\n` +
        `1️⃣ Add <b>@HostLookupBot</b> as an <b>Administrator</b> with invite users permission to your channel.\n\n` +
        `2️⃣ Then perform one of the following:\n` +
        `• <b>Forward a message or post from the channel here.</b>\n` +
        `• Or send the public @username or chat ID (e.g. <code>@channelusername</code> or <code>-1001234567890</code>).\n\n` +
        `<i>⚙️ The bot will automatically detect the chat ID, title, and generate an invite link.</i>`;

      try {
        return await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: text,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_cancel' }]],
          },
        });
      } catch {}
      return;
    }

    // 1.4. Prompt Broadcast
    if (data === 'admin_bc_prompt') {
      await setAdminStep(db, 'awaiting_broadcast');
      const text =
        `<blockquote>📢 <b>Broadcast Message to All Users</b></blockquote>\n\n` +
        `Please send the message you wish to broadcast to all users.\n\n` +
        `• Supports <b>text, photo, video, voice, audio, document, sticker, forwarded post, or custom buttons</b>.\n` +
        `• A <b>preview card and confirmation prompt</b> will be shown before final delivery.\n\n` +
        `<i>Click below to cancel:</i>`;

      try {
        return await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: text,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_cancel' }]],
          },
        });
      } catch {}
      return;
    }

    // 1.5. Execute Broadcast Send
    if (data.startsWith('admin_bc_send_')) {
      const targetMsgId = Number(data.replace('admin_bc_send_', ''));
      await setAdminStep(db, null);

      api.answerCallbackQuery({
        callback_query_id: query.id,
        text: '🚀 Broadcast started...',
      }).catch(() => {});

      try {
        await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `⏳ <b>Broadcasting message to all users...</b>\n\nPlease wait a moment.`,
          parse_mode: 'HTML',
        });
      } catch {}

      try {
        const allUsers = await db.all(sql`SELECT tg_id FROM users`);
        let success = 0;
        let failed = 0;

        for (const u of (allUsers || [])) {
          try {
            await api.copyMessage({
              chat_id: u.tg_id,
              from_chat_id: ADMIN_ID,
              message_id: targetMsgId,
            });
            success++;
          } catch {
            failed++;
          }
        }

        const reportText =
          `<blockquote>🏁 <b>Broadcast Delivery Report</b></blockquote>\n\n` +
          `• 👥 <b>Total Users in Database:</b> <code>${allUsers?.length || 0}</code>\n` +
          `• ✅ <b>Successfully Delivered:</b> <code>${success}</code>\n` +
          `• 🚫 <b>Failed / Blocked:</b> <code>${failed}</code>`;

        return await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: reportText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back to Dashboard', callback_data: 'admin_panel' }]],
          },
        });
      } catch (err) {
        return await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `❌ Broadcast error: ${escapeHtml(err.message)}`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back to Dashboard', callback_data: 'admin_panel' }]],
          },
        });
      }
    }

    // 1.6. User List Inspection
    if (data === 'admin_user_list') {
      try {
        const userList = await db.all(sql`SELECT * FROM users ORDER BY id DESC LIMIT 20`);
        const total = await db.get(sql`SELECT count(*) as count FROM users`);
        let resp = `<blockquote>👥 <b>Registered Users (${total?.count || 0}):</b></blockquote>\n\n`;

        if (!userList || userList.length === 0) {
          resp += `<i>No users registered in database yet.</i>`;
        } else {
          userList.forEach((u, i) => {
            const name = escapeHtml(u.first_name || 'Anonymous');
            const uname = u.username ? `@${u.username}` : 'No username';
            resp += `${i + 1}. <b>${name}</b> (${uname})\n`;
            resp += `   • ID: <code>${u.tg_id}</code>\n`;
            if (u.created_at) {
              const dateStr = typeof u.created_at === 'number' ? new Date(u.created_at * 1000).toISOString().split('T')[0] : u.created_at;
              resp += `   • Date: <code>${dateStr}</code>\n`;
            }
          });
        }

        return await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: resp,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔄 Refresh List', callback_data: 'admin_user_list' },
                { text: '🔙 Back to Dashboard', callback_data: 'admin_panel' },
              ],
            ],
          },
        });
      } catch (err) {
        return await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `❌ Error querying users: ${escapeHtml(err.message)}`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back to Dashboard', callback_data: 'admin_panel' }]],
          },
        });
      }
    }

    // 1.7. Delete Channel
    if (data.startsWith('admin_del_')) {
      const chId = Number(data.replace('admin_del_', ''));
      try {
        await db.run(sql`DELETE FROM fsub_channels WHERE id = ${chId}`);
        api.answerCallbackQuery({
          callback_query_id: query.id,
          text: `✅ Channel #${chId} deleted successfully.`,
        }).catch(() => {});
      } catch {}

      // Refresh channel list
      try {
        const list = await db.all(sql`SELECT * FROM fsub_channels ORDER BY id ASC`);
        let resp = `<blockquote>📢 <b>Force-Join Channels Management (${list?.length || 0}):</b></blockquote>\n\n`;
        const buttons = [];

        if (!list || list.length === 0) {
          resp += `<i>No channels registered in database.</i>\n`;
        } else {
          for (const ch of list) {
            const statusIcon = ch.is_active ? '🟢 Active' : '⚪️ Inactive';
            resp += `<b>#${ch.id}</b> | <b>${escapeHtml(ch.title || 'Channel')}</b> (${statusIcon})\n`;
            resp += `• <b>Chat ID:</b> <code>${ch.chat_id}</code>\n`;
            resp += `• <b>Link:</b> <a href="${ch.invite_link}">${ch.invite_link}</a>\n\n`;
            buttons.push([
              { text: `❌ Delete #${ch.id} (${ch.title || ch.chat_id})`, callback_data: `admin_del_${ch.id}` }
            ]);
          }
        }
        buttons.push([
          { text: '➕ Add Channel', callback_data: 'admin_add_channel_prompt' },
          { text: '🔙 Back to Dashboard', callback_data: 'admin_panel' }
        ]);

        return await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: resp,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: buttons },
        });
      } catch {}
      return;
    }

    // 1.8. Cancel Admin State
    if (data === 'admin_cancel') {
      await setAdminStep(db, null);
      api.answerCallbackQuery({
        callback_query_id: query.id,
        text: 'Operation cancelled.',
      }).catch(() => {});

      // Return to admin panel
      let totalUsers = 0;
      let activeChannels = 0;
      try {
        const u = await db.get(sql`SELECT count(*) as count FROM users`);
        totalUsers = u?.count || 0;
        const c = await db.get(sql`SELECT count(*) as count FROM fsub_channels WHERE is_active = true`);
        activeChannels = c?.count || 0;
      } catch {}

      const panelText =
        `<blockquote>⚙️ <b>Host Lookup Admin Dashboard</b></blockquote>\n\n` +
        `📊 <b>Live Database Statistics:</b>\n` +
        `• 👥 <b>Total Users:</b> <code>${totalUsers}</code> users\n` +
        `• 📢 <b>Force-Join Channels:</b> <code>${activeChannels}</code> active\n\n` +
        `<i>Select an option below to manage the bot:</i>`;

      const panelKeyboard = {
        inline_keyboard: [
          [
            { text: '📢 Manage Channels', callback_data: 'admin_fsub' },
            { text: '➕ Add Channel', callback_data: 'admin_add_channel_prompt' },
          ],
          [
            { text: '📢 Broadcast Message', callback_data: 'admin_bc_prompt' },
            { text: '👥 User List', callback_data: 'admin_user_list' },
          ],
          [
            { text: '🔄 Refresh Statistics', callback_data: 'admin_refresh_stats' },
          ],
        ],
      };

      try {
        return await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: panelText,
          parse_mode: 'HTML',
          reply_markup: panelKeyboard,
        });
      } catch {}
      return;
    }
  }

  // ==========================================
  // 1.9. LANGUAGE SWITCHING CALLBACKS
  // ==========================================
  if (data === 'menu_language') {
    const userLang = await getUserLang(db, fromUserId);
    const card = getLanguageCard(userLang);
    try {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: card.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: card.reply_markup,
      });
    } catch {}
    return;
  }

  if (data === 'set_lang_en' || data === 'set_lang_fa') {
    const newLang = data === 'set_lang_en' ? 'en' : 'fa';
    await setUserLang(db, fromUserId, newLang);

    const alertText = newLang === 'en' ? '✅ Language set to English' : '✅ زبان روی فارسی تنظیم شد';
    api.answerCallbackQuery({
      callback_query_id: query.id,
      text: alertText,
    }).catch(() => {});

    const card = getLanguageSuccessCard(newLang);
    try {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: card.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: card.reply_markup,
      });
    } catch {}
    return;
  }

  // ==========================================
  // 2. MAIN MENU
  // ==========================================
  if (data === 'menu_main') {
    const userLang = await getUserLang(db, fromUserId);
    const isFa = userLang === 'fa';
    const welcomeText = formatWelcomeCard(userLang);
    const keyboard = {
      inline_keyboard: [
        [
          { text: isFa ? '🔍 استعلام سریع اینلاین' : '🔍 Fast Inline Lookup', switch_inline_query_current_chat: '' },
        ],
        [
          { text: isFa ? '🌐 تست سرور 1.1.1.1' : '🌐 Test with 1.1.1.1', callback_data: 'wip_1.1.1.1' },
          { text: isFa ? '⚡️ تست google.com' : '⚡️ Test with google.com', callback_data: 'wboth_google.com' },
        ],
        [
          { text: '🌐 Language / زبان', callback_data: 'menu_language' },
          { text: '🐙 Open Source on GitHub ↗️', url: 'https://github.com/dalroot/host-lookup-bot' },
        ],
      ],
    };

    try {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: welcomeText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
    } catch {}
    return;
  }

  // ==========================================
  // 3. MULTI-NODE PING CHECK (GLOBAL + IRAN)
  // ==========================================
  if (data.startsWith('wping_')) {
    const target = cleanHost(data.replace('wping_', ''));
    const userLang = await getUserLang(db, fromUserId);
    const isFa = userLang === 'fa';

    api.answerCallbackQuery({
      callback_query_id: query.id,
      text: isFa ? '⏳ در حال سنجش پینگ از ۱۸ نقطه دنیا...' : '⏳ Measuring latency across 18 nodes...',
      show_alert: false,
    }).catch(() => {});

    // Show loading state in-place
    try {
      await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: isFa
          ? `<blockquote>📡 <b>تست پینگ چندنقطه‌ای و لایونس (Multi-Node Ping)</b></blockquote>\n\n` +
            `⏳ <i>در حال ارسال پکت‌های پینگ و سنجش تاخیر از ۱۸ نقطه جهان و استان‌های ایران برای</i> <code>${escapeHtml(target)}</code><i>...\n(لطفاً چند ثانیه صبر کنید)</i>`
          : `<blockquote>📡 <b>Multi-Node Ping & Latency Matrix</b></blockquote>\n\n` +
            `⏳ <i>Measuring ICMP latency across 18 global & Iran provincial nodes for</i> <code>${escapeHtml(target)}</code><i>...\n(please wait ~3.5 seconds)</i>`,
        parse_mode: 'HTML',
      });
    } catch {}

    try {
      const ipLookupPromise = isIpAddress(target)
        ? lookupIp(target)
        : resolveDomainIp(target).then(ip => (ip ? lookupIp(ip) : null)).catch(() => null);

      const [ipData, pingResult] = await Promise.all([
        ipLookupPromise,
        runMultiPingCheck(target),
      ]);

      const card = formatMultiPingCard(target, pingResult, ipData, userLang);

      const keyboard = [
        [
          { text: isFa ? '🔄 تست مجدد (Re-Ping)' : '🔄 Re-Ping', callback_data: `wping_${target}` },
          { text: isFa ? '📋 جزئیات هویز' : '📋 WHOIS Details', callback_data: `wboth_${target}` },
        ],
        [
          { text: isFa ? '📡 رکوردهای DNS' : '📡 DNS Records', callback_data: `wdns_${target}` },
          { text: isFa ? '🔍 استعلام جدید' : '🔍 New Lookup', switch_inline_query_current_chat: '' },
        ],
        [
          { text: isFa ? '🏠 منوی اصلی' : '🏠 Main Menu', callback_data: 'menu_main' },
          { text: '🔗 Check-Host Web Report ↗️', url: `https://check-host.net/check-report?host=${encodeURIComponent(target)}` },
        ],
      ];

      return await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: card,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      console.error('Error updating multi-ping card:', err);
    }
    return;
  }

  // ==========================================
  // 4. DOMAIN WHOIS & SERVER LOOKUP / REFRESH
  // ==========================================
  if (data.startsWith('wboth_')) {
    const domain = cleanHost(data.replace('wboth_', ''));
    const [domainData, resolvedIp] = await Promise.all([
      lookupDomain(domain),
      resolveDomainIp(domain),
    ]);

    let ipData = null;
    if (resolvedIp) {
      ipData = await lookupIp(resolvedIp);
    }

    const card = formatUnifiedCard(domain, domainData, ipData, resolvedIp);
    const keyboard = [
      [
        { text: '⚡️ Ping Check', callback_data: `wping_${domain}` },
        { text: '📡 DNS Records', callback_data: `wdns_${domain}` },
      ],
      [
        { text: '🔄 Refresh', callback_data: `wboth_${domain}` },
        { text: '🔗 Check-Host Report ↗️', url: `https://check-host.net/check-report?host=${encodeURIComponent(domain)}` },
      ],
      ...backButton,
    ];

    try {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: card,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      console.error('Error editing wboth message:', err);
    }
    return;
  }

  // ==========================================
  // 5. DNS RECORDS VIEW / REFRESH
  // ==========================================
  if (data.startsWith('wdns_')) {
    const domain = cleanHost(data.replace('wdns_', ''));
    const dnsRecords = await resolveAllDns(domain);
    const card = formatDnsCard(domain, dnsRecords);

    const keyboard = [
      [
        { text: '🔄 Refresh DNS', callback_data: `wdns_${domain}` },
        { text: '📋 WHOIS Details', callback_data: `wboth_${domain}` },
      ],
      [
        { text: '⚡️ Ping Check', callback_data: `wping_${domain}` },
        { text: '🔗 Check-Host Report ↗️', url: `https://check-host.net/check-report?host=${encodeURIComponent(domain)}` },
      ],
      ...backButton,
    ];

    try {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: card,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      console.error('Error editing wdns message:', err);
    }
    return;
  }

  // ==========================================
  // 6. IP LOOKUP / REFRESH
  // ==========================================
  if (data.startsWith('wip_')) {
    const ip = cleanHost(data.replace('wip_', ''));
    const ipData = await lookupIp(ip);
    const card = formatIpCard(ipData);

    const keyboard = [
      [
        { text: '⚡️ Ping Check', callback_data: `wping_${ip}` },
        { text: '🔄 Refresh', callback_data: `wip_${ip}` },
      ],
      [
        { text: '🔗 Check-Host Report ↗️', url: `https://check-host.net/ip-info?host=${encodeURIComponent(ip)}` },
      ],
      ...backButton,
    ];

    try {
      return await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: card,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      console.error('Error editing wip message:', err);
    }
    return;
  }
}
