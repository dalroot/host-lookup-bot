import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { users, fsubChannels } from '../schema.js';
import {
  isIpAddress,
  isDomain,
  cleanHost,
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
  checkAllChannels,
  formatJoinPrompt,
  ensureDefaultChannel,
  getAdminStep,
  setAdminStep,
  autoDetectChannel,
  verifyBotIsAdmin,
  getOrCreateInviteLink,
} from '../lib/channel.js';
import {
  getUserLang,
  setUserLang,
  getLanguageCard,
} from '../lib/i18n.js';
import {
  runMultiPingCheck,
  formatMultiPingCard,
} from '../lib/checkhost.js';

export const ADMIN_ID = 8629398713;

export default async function (message, ctx) {
  const chatId = message.chat.id;
  const rawText = (message.text || message.caption || '').trim();
  const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';
  const fromUser = message.from;
  const isAdmin = fromUser?.id === ADMIN_ID;
  const replyParams = message.message_id
    ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } }
    : {};

  // Ignore messages sent via this bot's inline query to avoid duplicate replies
  if (message.via_bot) {
    return;
  }

  // 1. Save or update user
  if (fromUser && fromUser.id) {
    try {
      await db.insert(users).values({
        tgId: fromUser.id,
        username: fromUser.username || null,
        firstName: fromUser.first_name || '',
      }).onConflictDoUpdate({
        target: users.tgId,
        set: {
          username: fromUser.username || null,
          firstName: fromUser.first_name || '',
        },
      });
    } catch (err) {
      console.error('Error saving user:', err);
    }
  }

  // ==========================================
  // 2. ADMIN INTERACTIVE CONVERSATION & COMMANDS
  // ==========================================
  if (isAdmin) {
    const currentStep = await getAdminStep(db);

    // 2.0. Handle Cancel State
    if (rawText === '/cancel' || rawText === 'cancel' || rawText === 'لغو' || rawText === 'انصراف') {
      await setAdminStep(db, null);
      return api.sendMessage({
        chat_id: ADMIN_ID,
        text: `✅ Operation cancelled. Returned to Admin Dashboard.`,
        reply_markup: {
          inline_keyboard: [[{ text: '⚙️ Back to Dashboard', callback_data: 'admin_panel' }]],
        },
      });
    }

    // 2.1. STATE: Awaiting Channel (Forward or @username)
    if (currentStep === 'awaiting_channel') {
      const detected = await autoDetectChannel(api, message, rawText);

      if (!detected || !detected.targetChatId) {
        return api.sendMessage({
          chat_id: ADMIN_ID,
          text:
            `⚠️ <b>Channel Not Detected!</b>\n\n` +
            `Please use one of these two methods:\n` +
            `1. <b>Forward</b> a message or post from the channel here.\n` +
            `2. Or send the public @username or chat ID (e.g. <code>@channelusername</code> or <code>-1001234567890</code>).\n\n` +
            `<i>Click below to cancel:</i>`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_cancel' }]],
          },
        });
      }

      // Check if bot is admin in the target channel
      const checkAdmin = await verifyBotIsAdmin(api, detected.targetChatId);
      if (!checkAdmin.ok) {
        const botName = checkAdmin.bot?.username || 'HostLookupBot';
        return api.sendMessage({
          chat_id: ADMIN_ID,
          text:
            `⚠️ <b>Bot is not an Admin in this channel!</b>\n\n` +
            `• <b>Channel:</b> ${escapeHtml(detected.title || 'Selected Channel')}\n` +
            `• <b>Chat ID:</b> <code>${detected.targetChatId}</code>\n\n` +
            `Please add <b>@${botName}</b> as an <b>Administrator</b> with invite permissions to the channel, then forward the message again.`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_cancel' }]],
          },
        });
      }

      // Fetch or create invite link
      const inviteLink = await getOrCreateInviteLink(
        api,
        detected.targetChatId,
        detected.username,
        detected.inviteLink
      );

      try {
        const exist = await db.get(sql`SELECT id FROM fsub_channels WHERE chat_id = ${String(detected.targetChatId)}`);
        if (exist) {
          await db.run(sql`UPDATE fsub_channels SET title = ${detected.title || 'Official Channel'}, invite_link = ${inviteLink}, is_active = true WHERE id = ${exist.id}`);
        } else {
          await db.insert(fsubChannels).values({
            chatId: String(detected.targetChatId),
            title: detected.title || 'Official Channel',
            inviteLink: inviteLink,
            isActive: true,
          });
        }
        await setAdminStep(db, null);

        return api.sendMessage({
          chat_id: ADMIN_ID,
          text:
            `✅ <b>Channel successfully added to Force-Join!</b>\n\n` +
            `• <b>Title:</b> ${escapeHtml(detected.title || 'Channel')}\n` +
            `• <b>Chat ID:</b> <code>${detected.targetChatId}</code>\n` +
            `• <b>Invite Link:</b> ${escapeHtml(inviteLink)}\n\n` +
            `<i>Channel membership is now mandatory for bot users.</i>`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📢 Manage Channels', callback_data: 'admin_fsub' },
                { text: '⚙️ Admin Dashboard', callback_data: 'admin_panel' },
              ],
            ],
          },
        });
      } catch (err) {
        return api.sendMessage({
          chat_id: ADMIN_ID,
          text: `❌ Error saving channel: ${escapeHtml(err.message)}`,
          parse_mode: 'HTML',
        });
      }
    }

    // 2.2. STATE: Awaiting Broadcast Message
    if (currentStep === 'awaiting_broadcast') {
      const msgId = message.message_id;
      let totalUsers = 0;
      try {
        const u = await db.get(sql`SELECT count(*) as count FROM users`);
        totalUsers = u?.count || 0;
      } catch {}

      // Copy message back to admin as preview
      try {
        await api.copyMessage({
          chat_id: ADMIN_ID,
          from_chat_id: ADMIN_ID,
          message_id: msgId,
        });
      } catch (err) {
        console.error('Error previewing broadcast message:', err);
      }

      return api.sendMessage({
        chat_id: ADMIN_ID,
        text:
          `<blockquote>⚠️ <b>Broadcast Message Preview (Sent Above)</b></blockquote>\n\n` +
          `• 👥 <b>Target Audience:</b> <code>${totalUsers}</code> active users\n\n` +
          `Do you want to confirm and broadcast this message to all users?`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🚀 Confirm & Send Broadcast', callback_data: `admin_bc_send_${msgId}` },
            ],
            [
              { text: '❌ Cancel', callback_data: 'admin_cancel' },
            ],
          ],
        },
      });
    }

    // 2.3. Admin Dashboard: /admin or /panel
    if (rawText === '/admin' || rawText === '/panel') {
      await ensureDefaultChannel(db);
      let totalUsers = 0;
      let activeChannels = 0;
      try {
        const u = await db.get(sql`SELECT count(*) as count FROM users`);
        totalUsers = u?.count || 0;
        const c = await db.get(sql`SELECT count(*) as count FROM fsub_channels WHERE is_active = true`);
        activeChannels = c?.count || 0;
      } catch (err) {}

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

      return api.sendMessage({
        chat_id: ADMIN_ID,
        text: panelText,
        parse_mode: 'HTML',
        reply_markup: panelKeyboard,
      });
    }

    // 2.4. Channels Management: /channels
    if (rawText === '/channels') {
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

        return api.sendMessage({
          chat_id: ADMIN_ID,
          text: resp,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: buttons },
        });
      } catch (err) {
        return api.sendMessage({
          chat_id: ADMIN_ID,
          text: `❌ Error: ${escapeHtml(err.message)}`,
          parse_mode: 'HTML',
        });
      }
    }

    // 2.5. User List: /users or /userlist
    if (rawText === '/users' || rawText === '/userlist') {
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

        return api.sendMessage({
          chat_id: ADMIN_ID,
          text: resp,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back to Dashboard', callback_data: 'admin_panel' }]],
          },
        });
      } catch (err) {
        return api.sendMessage({
          chat_id: ADMIN_ID,
          text: `❌ Error querying users: ${escapeHtml(err.message)}`,
          parse_mode: 'HTML',
        });
      }
    }

    // 2.6. Delete Channel Command: /delchannel <id>
    if (rawText.startsWith('/delchannel')) {
      const parts = rawText.split(/\s+/);
      const chId = Number(parts[1]);
      if (!chId) {
        return api.sendMessage({
          chat_id: ADMIN_ID,
          text: `⚠️ Usage: <code>/delchannel &lt;channel_id&gt;</code>`,
          parse_mode: 'HTML',
        });
      }

      try {
        await db.run(sql`DELETE FROM fsub_channels WHERE id = ${chId}`);
        return api.sendMessage({
          chat_id: ADMIN_ID,
          text: `✅ Channel #${chId} successfully deleted.`,
          parse_mode: 'HTML',
        });
      } catch (err) {
        return api.sendMessage({
          chat_id: ADMIN_ID,
          text: `❌ Error: ${escapeHtml(err.message)}`,
          parse_mode: 'HTML',
        });
      }
    }

    // 2.7. User Lookup: /user <tgId>
    if (rawText.startsWith('/user')) {
      const parts = rawText.split(/\s+/);
      const targetId = Number(parts[1]);
      if (!targetId) {
        return api.sendMessage({
          chat_id: ADMIN_ID,
          text: `⚠️ Usage: <code>/user &lt;user_tg_id&gt;</code>`,
          parse_mode: 'HTML',
        });
      }

      try {
        const u = await db.get(sql`SELECT * FROM users WHERE tg_id = ${targetId}`);
        if (!u) {
          return api.sendMessage({
            chat_id: ADMIN_ID,
            text: `❌ No user found with ID: <code>${targetId}</code>`,
            parse_mode: 'HTML',
          });
        }

        return api.sendMessage({
          chat_id: ADMIN_ID,
          text:
            `👤 <b>User Details:</b>\n` +
            `• Name: ${escapeHtml(u.first_name || '—')}\n` +
            `• Username: ${u.username ? '@' + u.username : '—'}\n` +
            `• Telegram ID: <code>${u.tg_id}</code>\n` +
            `• Registered: <code>${u.created_at || '—'}</code>`,
          parse_mode: 'HTML',
        });
      } catch (err) {
        return api.sendMessage({
          chat_id: ADMIN_ID,
          text: `❌ Error: ${escapeHtml(err.message)}`,
          parse_mode: 'HTML',
        });
      }
    }
  }

  // ==========================================
  // 3. MANDATORY CHANNEL MEMBERSHIP CHECK (NON-ADMINS)
  // ==========================================
  if (!isAdmin && !isGroup) {
    const check = await checkAllChannels(api, db, fromUser?.id);
    if (!check.passed) {
      const userLang = await getUserLang(db, fromUser?.id);
      const prompt = formatJoinPrompt(check.missing, userLang);
      return api.sendMessage({
        chat_id: chatId,
        text: prompt.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: prompt.reply_markup,
      });
    }
  }

  // ==========================================
  // 3.1. LANGUAGE SWITCHING COMMAND: /language or /lang
  // ==========================================
  if (
    rawText === '/language' ||
    rawText === '/lang' ||
    rawText.startsWith('/language@') ||
    rawText.startsWith('/lang@') ||
    rawText === 'زبان'
  ) {
    const userLang = await getUserLang(db, fromUser?.id);
    const card = getLanguageCard(userLang);
    return api.sendMessage({
      chat_id: chatId,
      text: card.text,
      parse_mode: 'HTML',
      ...replyParams,
      reply_markup: card.reply_markup,
    });
  }

  // ==========================================
  // 4. USER COMMANDS: /start & /help
  // ==========================================
  if (rawText.startsWith('/start') || rawText === '/help') {
    // Register commands for all users and language scopes
    const cmdList = [
      { command: 'start', description: '🚀 Main menu & bot introduction' },
      { command: 'whois', description: '🌐 Domain & IP WHOIS lookup' },
      { command: 'ip', description: '🖥️ IP intelligence, ASN & datacenter' },
      { command: 'dns', description: '📡 Query DNS records (A, AAAA, MX, NS...)' },
      { command: 'ping', description: '⚡ Multi-node global & Iran latency matrix' },
      { command: 'language', description: '🌐 Change language / تغییر زبان' },
      { command: 'help', description: 'ℹ️ Complete user manual & instructions' },
    ];
    const cmdListFa = [
      { command: 'start', description: '🚀 منوی اصلی و راهنما' },
      { command: 'whois', description: '🌐 استعلام هویز دامنه و آی‌پی' },
      { command: 'ip', description: '🖥️ اطلاعات آی‌پی، لوکیشن و دیتاسنتر' },
      { command: 'dns', description: '📡 استعلام رکوردهای DNS' },
      { command: 'ping', description: '⚡ تست پینگ چندنقطه‌ای جهانی و استانی' },
      { command: 'language', description: '🌐 تنظیم زبان / Change Language' },
      { command: 'help', description: 'ℹ️ راهنمای کامل استفاده' },
    ];
    const adminCmdList = [
      { command: 'start', description: '🚀 Main menu' },
      { command: 'admin', description: '⚙️ Open Admin Dashboard' },
      { command: 'channels', description: '📢 Manage Force-Join Channels' },
      { command: 'users', description: '👥 View registered users' },
      { command: 'ping', description: '⚡ Multi-node ping matrix' },
      { command: 'language', description: '🌐 Change language' },
      { command: 'help', description: 'ℹ️ Help & manual' },
    ];

    api.setMyCommands({ commands: cmdList }).catch(() => {});
    api.setMyCommands({ commands: cmdList, language_code: 'en' }).catch(() => {});
    api.setMyCommands({ commands: cmdListFa, language_code: 'fa' }).catch(() => {});
    api.setMyCommands({ commands: adminCmdList, scope: { type: 'chat', chat_id: ADMIN_ID } }).catch(() => {});
    api.setChatMenuButton({ menu_button: { type: 'commands' } }).catch(() => {});

    const userLang = await getUserLang(db, fromUser?.id);
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

    return api.sendMessage({
      chat_id: chatId,
      text: welcomeText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
  }

  // 4.1. Bare /whois Command
  if (rawText === '/whois') {
    return api.sendMessage({
      chat_id: chatId,
      text:
        `<blockquote>🌐 <b>WHOIS & Host Lookup</b></blockquote>\n\n` +
        `Please send any Domain or IP address to inspect (e.g. <code>google.com</code> or <code>1.1.1.1</code>):\n\n` +
        `<i>Or click the button below:</i>`,
      parse_mode: 'HTML',
      ...replyParams,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔍 Instant Inline Search', switch_inline_query_current_chat: '' }],
          [{ text: '🏠 Main Menu', callback_data: 'menu_main' }],
        ],
      },
    });
  }

  // 5. DNS Specific Command: /dns <domain>
  if (rawText.startsWith('/dns') || rawText.startsWith('/records')) {
    const domainArg = cleanRawInput(rawText.replace(/^\/(?:dns|records)(?:@[a-zA-Z0-9_]+)?\s*/i, ''));
    if (!domainArg || !isDomain(domainArg)) {
      return api.sendMessage({
        chat_id: chatId,
        text:
          `<blockquote>📡 <b>DNS Records Query</b></blockquote>\n\n` +
          `Please provide a valid domain to resolve DNS records (e.g. <code>google.com</code> or <code>cloudflare.com</code>):\n\n` +
          `<i>Or click the button below:</i>`,
        parse_mode: 'HTML',
        ...replyParams,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔍 Instant Inline Search', switch_inline_query_current_chat: '' }],
            [{ text: '🏠 Main Menu', callback_data: 'menu_main' }],
          ],
        },
      });
    }

    const domain = cleanHost(domainArg);
    const dnsRecords = await resolveAllDns(domain);
    const card = formatDnsCard(domain, dnsRecords);

    const keyboard = [
      [
        { text: '🔄 Refresh DNS', callback_data: `wdns_${domain}` },
        { text: '📋 WHOIS Details', callback_data: `wboth_${domain}` },
      ],
      [
        { text: '⚡️ Ping Check', callback_data: `wping_${domain}` },
        { text: '🔍 New Lookup', switch_inline_query_current_chat: '' },
      ],
      [
        { text: '🏠 Main Menu', callback_data: 'menu_main' },
        { text: '🔗 Check-Host Report ↗️', url: `https://check-host.net/check-report?host=${encodeURIComponent(domain)}` },
      ],
    ];

    return api.sendMessage({
      chat_id: chatId,
      text: card,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...replyParams,
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  // 6. IP Specific Command: /ip <address>
  if (rawText.startsWith('/ip')) {
    const ipArg = cleanRawInput(rawText.replace(/^\/ip(?:@[a-zA-Z0-9_]+)?\s*/i, ''));
    if (!ipArg || !isIpAddress(ipArg)) {
      return api.sendMessage({
        chat_id: chatId,
        text:
          `<blockquote>🖥️ <b>Server & IP Intelligence</b></blockquote>\n\n` +
          `Please provide a valid IP address to inspect (e.g. <code>1.1.1.1</code> or <code>8.8.8.8</code>):\n\n` +
          `<i>Or click the button below:</i>`,
        parse_mode: 'HTML',
        ...replyParams,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔍 Instant Inline Search', switch_inline_query_current_chat: '' }],
            [{ text: '🏠 Main Menu', callback_data: 'menu_main' }],
          ],
        },
      });
    }

    const ip = cleanHost(ipArg);
    const ipData = await lookupIp(ip);
    const card = formatIpCard(ipData);

    const keyboard = [
      [
        { text: '⚡️ Ping Check', callback_data: `wping_${ip}` },
        { text: '🔄 Refresh', callback_data: `wip_${ip}` },
      ],
      [
        { text: '🔍 New Lookup', switch_inline_query_current_chat: '' },
        { text: '🏠 Main Menu', callback_data: 'menu_main' },
      ],
      [
        { text: '🔗 Check-Host ↗️', url: `https://check-host.net/ip-info?host=${encodeURIComponent(ip)}` },
      ],
    ];

    return api.sendMessage({
      chat_id: chatId,
      text: card,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...replyParams,
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  // 6.5. Multi-Node Ping Command: /ping <target>
  if (rawText.startsWith('/ping')) {
    const targetArg = cleanRawInput(rawText.replace(/^\/ping(?:@[a-zA-Z0-9_]+)?\s*/i, ''));
    const userLang = await getUserLang(db, fromUser?.id);
    const isFa = userLang === 'fa';

    if (!targetArg) {
      return api.sendMessage({
        chat_id: chatId,
        text: isFa
          ? `<blockquote>📡 <b>تست پینگ چندنقطه‌ای (Multi-Node Ping)</b></blockquote>\n\n` +
            `لطفاً نام دامنه یا آی‌پی مورد نظر را وارد نمایید (مثال: <code>google.com</code> یا <code>1.1.1.1</code>):\n\n` +
            `<i>یا دستور را به این شکل بفرستید: <code>/ping google.com</code></i>`
          : `<blockquote>📡 <b>Multi-Node Ping & Latency Matrix</b></blockquote>\n\n` +
            `Please provide a domain or IP address to ping (e.g. <code>google.com</code> or <code>1.1.1.1</code>):\n\n` +
            `<i>Example: <code>/ping 1.1.1.1</code></i>`,
        parse_mode: 'HTML',
        ...replyParams,
        reply_markup: {
          inline_keyboard: [
            [{ text: isFa ? '🔍 استعلام سریع اینلاین' : '🔍 Instant Inline Search', switch_inline_query_current_chat: '' }],
            [{ text: isFa ? '🏠 منوی اصلی' : '🏠 Main Menu', callback_data: 'menu_main' }],
          ],
        },
      });
    }

    const target = cleanHost(targetArg);

    const loadingMsg = await api.sendMessage({
      chat_id: chatId,
      text: isFa
        ? `⏳ <i>در حال ارسال پکت‌های پینگ و سنجش تاخیر از ۱۸ نقطه جهان و استان‌های ایران برای</i> <code>${escapeHtml(target)}</code><i>...\n(لطفاً چند ثانیه صبر کنید)</i>`
        : `⏳ <i>Measuring ICMP latency across 18 global & Iran provincial nodes for</i> <code>${escapeHtml(target)}</code><i>...\n(please wait ~3.5 seconds)</i>`,
      parse_mode: 'HTML',
      ...replyParams,
    });

    let ipData = null;
    if (isIpAddress(target)) {
      ipData = await lookupIp(target);
    } else {
      const resolved = await resolveDomainIp(target);
      if (resolved) {
        ipData = await lookupIp(resolved);
      }
    }

    const pingResult = await runMultiPingCheck(target);
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

    if (loadingMsg && loadingMsg.message_id) {
      return api.editMessageText({
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        text: card,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      });
    } else {
      return api.sendMessage({
        chat_id: chatId,
        text: card,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...replyParams,
        reply_markup: { inline_keyboard: keyboard },
      });
    }
  }

  // 7. Group Filter
  if (isGroup) {
    const isCommand = rawText.startsWith('/');
    const isMention = rawText.includes('@');
    const isReply = !!message.reply_to_message;
    if (!isCommand && !isMention && !isReply) {
      return;
    }
  }

  // 8. Target Extraction
  const targetInput = extractTarget(rawText, message);

  // 8.1. IP Target
  if (isIpAddress(targetInput)) {
    const ip = cleanHost(targetInput);
    const ipData = await lookupIp(ip);
    const card = formatIpCard(ipData);

    const keyboard = [
      [
        { text: '⚡️ Ping Check', callback_data: `wping_${ip}` },
        { text: '🔄 Refresh', callback_data: `wip_${ip}` },
      ],
      [
        { text: '🔍 New Lookup', switch_inline_query_current_chat: '' },
        { text: '🏠 Main Menu', callback_data: 'menu_main' },
      ],
      [
        { text: '🔗 Check-Host Report ↗️', url: `https://check-host.net/ip-info?host=${encodeURIComponent(ip)}` },
      ],
    ];

    return api.sendMessage({
      chat_id: chatId,
      text: card,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...replyParams,
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  // 8.2. Domain Target
  if (isDomain(targetInput)) {
    const domain = cleanHost(targetInput);

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
        { text: '🔍 New Lookup', switch_inline_query_current_chat: '' },
      ],
      [
        { text: '🏠 Main Menu', callback_data: 'menu_main' },
        { text: '🔗 Check-Host Report ↗️', url: `https://check-host.net/check-report?host=${encodeURIComponent(domain)}` },
      ],
    ];

    return api.sendMessage({
      chat_id: chatId,
      text: card,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...replyParams,
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  if (isGroup) return;

  return api.sendMessage({
    chat_id: chatId,
    text:
      `<blockquote>🔍 <b>Host Lookup</b></blockquote>\n\n` +
      `Send any valid <b>Domain</b> (e.g. <code>google.com</code>) or <b>IP Address</b> (e.g. <code>1.1.1.1</code>) to inspect.\n\n` +
      `Or use <code>/dns domain.com</code> to view DNS records.`,
    parse_mode: 'HTML',
    ...replyParams,
  });
}

function extractTarget(text, message) {
  let input = text;
  if (message.reply_to_message && message.reply_to_message.text) {
    const cleaned = cleanRawInput(text);
    if (!isIpAddress(cleaned) && !isDomain(cleaned)) {
      input = message.reply_to_message.text;
    }
  }
  return cleanRawInput(input);
}

function cleanRawInput(raw) {
  let s = (raw || '').trim();
  s = s.replace(/^\/(?:whois|check|ip|lookup|host|dns)(?:@[a-zA-Z0-9_]+)?\s*/i, '');
  s = s.replace(/@[a-zA-Z0-9_]+/g, '');
  const match = s.match(/(?:https?:\/\/)?([a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)*\.[a-zA-Z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b)/i);
  if (match) return cleanHost(match[1]);
  return cleanHost(s.split(/\s+/)[0] || '');
}
