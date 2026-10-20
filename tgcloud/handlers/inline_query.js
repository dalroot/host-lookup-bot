import { api } from 'sdk';
import {
  isIpAddress,
  isDomain,
  cleanHost,
  lookupIp,
  lookupDomain,
  resolveDomainIp,
  formatIpCard,
  formatUnifiedCard,
} from '../lib/whois.js';

export default async function (inlineQuery, ctx) {
  const queryId = inlineQuery.id;
  const rawQuery = (inlineQuery.query || '').trim();

  if (!rawQuery) {
    return api.answerInlineQuery({
      inline_query_id: queryId,
      results: [
        {
          type: 'article',
          id: 'help',
          title: '🔍 Host Lookup — Enter Domain or IP',
          description: 'Example: @HostLookupBot google.com or @HostLookupBot 1.1.1.1',
          input_message_content: {
            message_text:
              `<blockquote>🔍 <b>Host Lookup — Fast WHOIS & Server Inspector</b></blockquote>\n\n` +
              `Send any domain or IP address directly to inspect registrar, nameservers, ASN, and hosting details.`,
            parse_mode: 'HTML',
          },
        },
      ],
      cache_time: 10,
    });
  }

  const clean = cleanHost(rawQuery);

  // 1. IP Lookup
  if (isIpAddress(clean)) {
    const ipData = await lookupIp(clean);
    const card = formatIpCard(ipData);
    const title = ipData.country ? `IP: ${clean} (${ipData.country})` : `IP: ${clean}`;
    const desc = ipData.org || ipData.isp || 'Inspect IP geolocation & ASN';

    return api.answerInlineQuery({
      inline_query_id: queryId,
      results: [
        {
          type: 'article',
          id: `ip_${clean}`,
          title: `🖥️ ${title}`,
          description: desc,
          input_message_content: {
            message_text: card,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          },
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔍 New Lookup', switch_inline_query_current_chat: '' },
                { text: '🏠 Main Menu', url: 'https://t.me/HostLookupBot?start=main' },
              ],
              [
                { text: '🔗 Check-Host Report ↗️', url: `https://check-host.net/ip-info?host=${encodeURIComponent(clean)}` },
              ],
            ],
          },
        },
      ],
      cache_time: 60,
    });
  }

  // 2. Domain Lookup
  if (isDomain(clean)) {
    const [domainData, resolvedIp] = await Promise.all([
      lookupDomain(clean),
      resolveDomainIp(clean),
    ]);

    let ipData = null;
    if (resolvedIp) {
      ipData = await lookupIp(resolvedIp);
    }

    const card = formatUnifiedCard(clean, domainData, ipData, resolvedIp);
    const registrar = domainData.registrar || 'Active Domain';
    const loc = ipData && ipData.country ? ` (${ipData.country})` : '';

    return api.answerInlineQuery({
      inline_query_id: queryId,
      results: [
        {
          type: 'article',
          id: `domain_${clean}`,
          title: `🌐 WHOIS: ${clean}`,
          description: `Registrar: ${registrar} | IP: ${resolvedIp || 'N/A'}${loc}`,
          input_message_content: {
            message_text: card,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          },
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔍 New Lookup', switch_inline_query_current_chat: '' },
                { text: '🏠 Main Menu', url: 'https://t.me/HostLookupBot?start=main' },
              ],
              [
                { text: '🔗 Check-Host Report ↗️', url: `https://check-host.net/check-report?host=${encodeURIComponent(clean)}` },
              ],
            ],
          },
        },
      ],
      cache_time: 60,
    });
  }

  // Fallback for invalid query
  return api.answerInlineQuery({
    inline_query_id: queryId,
    results: [
      {
        type: 'article',
        id: 'invalid',
        title: `⚠️ Invalid Host: "${clean}"`,
        description: 'Please enter a valid domain (e.g. example.com) or IP (e.g. 8.8.8.8)',
        input_message_content: {
          message_text: `⚠️ <b>Invalid Host:</b> <code>${clean}</code>\nPlease enter a valid domain or IP address.`,
          parse_mode: 'HTML',
        },
      },
    ],
    cache_time: 5,
  });
}
