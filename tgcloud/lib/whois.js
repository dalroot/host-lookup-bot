import { fetch } from 'sdk';

/**
 * Clean and normalize host input (domain or IP)
 */
export function cleanHost(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^(?:https?:\/\/)/i, '');
  s = s.split('/')[0];
  s = s.split(':')[0];
  s = s.split('?')[0];
  s = s.split('#')[0];
  return s.trim();
}

/**
 * Validate IPv4 and IPv6
 */
export function isIpAddress(input) {
  const host = cleanHost(input);
  const ipv4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  const ipv6 = /^([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i;
  return ipv4.test(host) || ipv6.test(host);
}

/**
 * Validate Domain name
 */
export function isDomain(input) {
  const host = cleanHost(input);
  if (isIpAddress(host)) return false;
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(host);
}

/**
 * Extract root domain supporting multi-level ccTLDs (.co.uk, .com.tr, .ac.ir, etc.)
 */
export function extractRootDomain(host) {
  const parts = host.split('.');
  if (parts.length <= 2) return host;

  const secondLevel = [
    'co.uk', 'gov.uk', 'ac.uk', 'org.uk',
    'com.au', 'net.au', 'org.au',
    'co.jp', 'ne.jp',
    'com.br', 'net.br',
    'co.ir', 'ac.ir', 'id.ir', 'net.ir', 'org.ir', 'gov.ir', 'sch.ir',
    'com.tr', 'net.tr', 'org.tr',
    'com.ua', 'net.ua',
    'co.za', 'net.za',
    'com.ru', 'net.ru', 'org.ru',
  ];

  const lastTwo = parts.slice(-2).join('.');
  if (secondLevel.includes(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/**
 * Resolve IPv4 via Cloudflare DoH
 */
export async function resolveDomainIp(domain) {
  try {
    const clean = cleanHost(domain);
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${clean}&type=A`, {
      headers: { 'Accept': 'application/dns-json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.Answer && data.Answer.length > 0) {
      const aRecord = data.Answer.find(a => a.type === 1);
      return aRecord ? aRecord.data : data.Answer[0].data;
    }
    return null;
  } catch (err) {
    console.error('DoH resolve error:', err);
    return null;
  }
}

/**
 * Resolve comprehensive DNS records (A, AAAA, MX, NS, TXT, CNAME, SOA)
 */
export async function resolveAllDns(domain) {
  const host = cleanHost(domain);
  const types = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME'];
  const results = {};

  await Promise.all(
    types.map(async (t) => {
      try {
        const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=${t}`, {
          headers: { 'Accept': 'application/dns-json' },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.Answer && Array.isArray(data.Answer)) {
            results[t] = data.Answer.map(ans => ans.data.replace(/^"|"$/g, ''));
          } else {
            results[t] = [];
          }
        } else {
          results[t] = [];
        }
      } catch {
        results[t] = [];
      }
    })
  );

  return results;
}

/**
 * Resolve domain NS records
 */
export async function resolveDomainNs(domain) {
  try {
    const root = extractRootDomain(cleanHost(domain));
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${root}&type=NS`, {
      headers: { 'Accept': 'application/dns-json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.Answer && data.Answer.length > 0) {
      return data.Answer.filter(a => a.type === 2).map(a => a.data.replace(/\.$/, '').toLowerCase());
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Lookup IP Geolocation, Hosting & ASN info
 */
export async function lookupIp(ip) {
  try {
    const clean = cleanHost(ip);
    const res = await fetch(`http://ip-api.com/json/${clean}?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,query,reverse`);
    if (!res.ok) return { error: `IP service error (${res.status})` };
    const data = await res.json();
    if (data.status !== 'success') {
      return { error: data.message || 'Invalid IP address' };
    }
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Lookup Domain WHOIS via RDAP with special .ir fallback
 */
export async function lookupDomain(domain) {
  const host = cleanHost(domain);
  const root = extractRootDomain(host);
  const isIr = root.endsWith('.ir');

  if (isIr) {
    const nsList = await resolveDomainNs(root);
    return {
      domain: root,
      originalHost: host,
      isSubdomain: host !== root,
      isIr: true,
      registrar: 'IRNIC Registry (nic.ir)',
      nameservers: nsList,
      status: ['active'],
      note: 'ccTLD .ir is managed by IRNIC (Institute for Research in Fundamental Sciences).',
    };
  }

  try {
    const res = await fetch(`https://rdap.org/domain/${root}`, {
      headers: { 'Accept': 'application/rdap+json, application/json' },
    });
    if (!res.ok) {
      if (res.status === 404) return { error: `Domain ${root} appears unregistered or not found in RDAP.` };
      return { error: `RDAP error (${res.status})` };
    }
    const data = await res.json();

    let registrar = 'Unknown';
    let ianaId = null;
    if (data.entities && Array.isArray(data.entities)) {
      const regEntity = data.entities.find(e => e.roles && e.roles.includes('registrar'));
      if (regEntity) {
        if (regEntity.publicIds && regEntity.publicIds[0]) {
          ianaId = regEntity.publicIds[0].identifier;
        }
        if (regEntity.vcardArray && regEntity.vcardArray[1]) {
          const fnRow = regEntity.vcardArray[1].find(item => item[0] === 'fn');
          if (fnRow) registrar = fnRow[3];
        }
      }
    }

    let created = null;
    let expires = null;
    let updated = null;
    if (data.events && Array.isArray(data.events)) {
      for (const ev of data.events) {
        if (ev.eventAction === 'registration') created = ev.eventDate;
        if (ev.eventAction === 'expiration') expires = ev.eventDate;
        if (ev.eventAction === 'last changed') updated = ev.eventDate;
      }
    }

    let nameservers = [];
    if (data.nameservers && Array.isArray(data.nameservers)) {
      nameservers = data.nameservers.map(ns => (ns.ldhName || '').toLowerCase()).filter(Boolean);
    }
    if (nameservers.length === 0) {
      nameservers = await resolveDomainNs(root);
    }

    let dnssec = 'Unsigned';
    if (data.secureDNS && data.secureDNS.delegationSigned) {
      dnssec = 'Signed (Active)';
    }

    return {
      domain: root,
      originalHost: host,
      isSubdomain: host !== root,
      isIr: false,
      registrar,
      ianaId,
      created,
      expires,
      updated,
      status: data.status || ['active'],
      nameservers,
      dnssec,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Format IP information card
 */
export function formatIpCard(data, liveness = null) {
  if (data.error) {
    return (
      `<blockquote>⚠️ <b>IP Lookup Error</b></blockquote>\n\n` +
      `<code>${escapeHtml(data.error)}</code>`
    );
  }

  const flag = getFlagEmoji(data.countryCode);
  const cityStr = data.city ? `${data.city}, ` : '';
  const locationStr = `${flag} ${cityStr}${data.country} (${data.countryCode})`;

  let livenessHtml = '';
  if (liveness) {
    if (liveness.online) {
      livenessHtml = `⚡️ <b>Liveness (Ping):</b>\n<blockquote>🟢 Online (<code>${liveness.ms} ms</code> via Frankfurt)</blockquote>\n`;
    } else {
      livenessHtml = `⚡️ <b>Liveness (Ping):</b>\n<blockquote>🔴 Unreachable / Packet Loss (via Frankfurt)</blockquote>\n`;
    }
  }

  return (
    `<blockquote>🖥️ <b>Server & IP Intelligence</b></blockquote>\n\n` +
    `🌐 <b>IP Address:</b>\n` +
    `<blockquote><code>${data.query}</code></blockquote>\n` +
    livenessHtml +
    `📍 <b>Location:</b>\n` +
    `<blockquote>${locationStr}</blockquote>\n` +
    `🏢 <b>Datacenter / Organization:</b>\n` +
    `<blockquote><code>${escapeHtml(data.org || data.isp || 'Unknown')}</code></blockquote>\n` +
    `📡 <b>ISP:</b>\n` +
    `<blockquote><code>${escapeHtml(data.isp || '-')}</code></blockquote>\n` +
    `🔢 <b>ASN & Route:</b>\n` +
    `<blockquote><code>${escapeHtml(data.as || '-')}</code></blockquote>\n` +
    `🕒 <b>Timezone:</b>\n` +
    `<blockquote><code>${data.timezone || 'UTC'}</code></blockquote>\n` +
    (data.reverse ? `🔄 <b>Reverse DNS (PTR):</b>\n<blockquote><code>${escapeHtml(data.reverse)}</code></blockquote>\n` : '') +
    `🗺 <a href="https://www.google.com/maps/search/?api=1&query=${data.lat},${data.lon}">View Location on Google Maps</a>\n\n` +
    `<i>⚡️ Bot is active and ready for next lookup (send domain or IP)</i>`
  );
}

/**
 * Format Comprehensive WHOIS & Server Card
 */
export function formatUnifiedCard(domain, domainData, ipData, resolvedIp, liveness = null) {
  if (domainData.error) {
    return (
      `<blockquote>🌐 <b>WHOIS Lookup — ${escapeHtml(domain)}</b></blockquote>\n\n` +
      `⚠️ <code>${escapeHtml(domainData.error)}</code>`
    );
  }

  const isSub = domainData.isSubdomain;
  const flag = ipData && ipData.countryCode ? getFlagEmoji(ipData.countryCode) : '🌐';
  const countryName = ipData && ipData.country ? `${flag} ${ipData.city ? ipData.city + ', ' : ''}${ipData.country}` : 'Unknown';
  const orgName = ipData && (ipData.org || ipData.isp) ? ipData.org || ipData.isp : 'Unknown';

  const regDate = domainData.created ? formatDate(domainData.created) : 'Unknown';
  const expDate = domainData.expires ? formatDate(domainData.expires) : 'Unknown';
  const daysLeft = domainData.expires ? getDaysRemaining(domainData.expires) : null;
  const daysText = daysLeft !== null ? (daysLeft > 0 ? ` (${daysLeft} days left)` : ` ⚠️ (Expired)`) : '';

  let nsLines = '• <i>No nameservers found</i>';
  if (domainData.nameservers && domainData.nameservers.length > 0) {
    nsLines = domainData.nameservers.map(ns => `• <code>${escapeHtml(ns)}</code>`).join('\n');
  }

  let statusLines = '• active';
  if (domainData.status && Array.isArray(domainData.status) && domainData.status.length > 0) {
    statusLines = domainData.status.map(s => `• <code>${escapeHtml(s)}</code>`).join('\n');
  }

  let livenessLine = '';
  if (liveness) {
    if (liveness.online) {
      livenessLine = `\n• <b>Liveness:</b> 🟢 Online (<code>${liveness.ms} ms</code> via Frankfurt)`;
    } else {
      livenessLine = `\n• <b>Liveness:</b> 🔴 Unreachable / Packet Loss`;
    }
  }

  let text =
    `<blockquote>🌐 <b>WHOIS & Host Lookup — ${escapeHtml(domainData.domain)}</b></blockquote>\n\n` +
    (isSub ? `ℹ️ <i>Queried Host:</i> <code>${escapeHtml(domainData.originalHost)}</code>\n\n` : '') +
    `🏢 <b>Registrar:</b>\n` +
    `<blockquote><code>${escapeHtml(domainData.registrar || 'Unknown')}</code>${domainData.ianaId ? ` (IANA: ${domainData.ianaId})` : ''}</blockquote>\n` +
    `📅 <b>Important Dates:</b>\n` +
    `<blockquote>• Created: <code>${regDate}</code>\n• Expires: <code>${expDate}</code>${daysText}</blockquote>\n` +
    `🛡 <b>DNSSEC:</b> <code>${domainData.dnssec || 'Unsigned'}</code>\n\n` +
    `📋 <b>Domain Status:</b>\n` +
    `<blockquote expandable>${statusLines}</blockquote>\n\n` +
    `📡 <b>Nameservers (NS):</b>\n` +
    `<blockquote expandable>${nsLines}</blockquote>\n\n` +
    `➖➖➖➖➖➖➖➖➖➖\n\n` +
    `🖥️ <b>Server & Hosting Intelligence:</b>\n` +
    `<blockquote>• <b>IP:</b> <code>${resolvedIp || 'Unknown'}</code>\n` +
    `• <b>Location:</b> ${countryName}\n` +
    `• <b>Hosting:</b> <code>${escapeHtml(orgName)}</code>\n` +
    `• <b>ASN:</b> <code>${escapeHtml(ipData?.as || '-')}</code>` +
    (ipData?.reverse ? `\n• <b>PTR:</b> <code>${escapeHtml(ipData.reverse)}</code>` : '') +
    livenessLine +
    `</blockquote>`;

  if (domainData.note) {
    text += `\n\n💡 <i>${escapeHtml(domainData.note)}</i>`;
  }

  text += `\n\n<i>⚡️ Bot is active and ready for next lookup (send domain or IP)</i>`;
  return text;
}

/**
 * Format DNS Records Card
 */
export function formatDnsCard(domain, records) {
  let text = `<blockquote>🔍 <b>DNS Records — ${escapeHtml(domain)}</b></blockquote>\n\n`;

  const sections = [
    { key: 'A', title: '🌐 IPv4 Addresses (A)' },
    { key: 'AAAA', title: '🌐 IPv6 Addresses (AAAA)' },
    { key: 'CNAME', title: '🔗 Canonical Name (CNAME)' },
    { key: 'MX', title: '📧 Mail Exchange (MX)' },
    { key: 'NS', title: '📡 Nameservers (NS)' },
    { key: 'TXT', title: '📝 Text Records (TXT)' },
  ];

  let hasAny = false;
  for (const s of sections) {
    const list = records[s.key] || [];
    if (list.length > 0) {
      hasAny = true;
      text += `<b>${s.title}:</b>\n<blockquote>`;
      text += list.map(item => `• <code>${escapeHtml(item)}</code>`).join('\n');
      text += `</blockquote>\n\n`;
    }
  }

  if (!hasAny) {
    text += `<blockquote><i>No DNS records found via Cloudflare 1.1.1.1 resolver.</i></blockquote>`;
  }

  text += `\n\n<i>⚡️ Bot is active and ready for next lookup (send domain or IP)</i>`;
  return text.trim();
}

/**
 * Format Start / Help Card
 */
export function formatWelcomeCard(lang = 'en') {
  if (lang === 'fa') {
    return (
      `<blockquote>🔍 <b>ربات هوشمند Host Lookup — استعلام هویز، DNS و اطلاعات سرور</b></blockquote>\n\n` +
      `سریع، سرورلس، کاملاً رایگان و بدون ردپا در بستر ابری تلگرام.\n\n` +
      `<b>🚀 روش‌های استفاده:</b>\n` +
      `• <b>در چت خصوصی:</b> نام دامنه (مانند <code>google.com</code>) یا آی‌پی (مانند <code>1.1.1.1</code>) را مستقیم بفرستید.\n` +
      `• <b>در گروه‌ها:</b> ربات را منشن کنید: <code>@HostLookupBot domain.com</code>\n` +
      `• <b>حالت اینلاین (Inline):</b> در هر چتی تایپ کنید <code>@HostLookupBot </code>!\n\n` +
      `<b>🛠 دستورات ربات:</b>\n` +
      `• <code>/start</code> — منوی اصلی و معرفی امکانات\n` +
      `• <code>/whois &lt;هدف&gt;</code> — استعلام جامع هویز، وضعیت و سرور\n` +
      `• <code>/ip &lt;آدرس&gt;</code> — مشخصات لوکیشن، دیتاسنتر و ASN\n` +
      `• <code>/dns &lt;دامنه&gt;</code> — استعلام تمام رکوردهای DNS (A, AAAA, MX, NS...)\n` +
      `• <code>/language</code> — تغییر زبان ربات (English / فارسی)\n` +
      `• <code>/help</code> — راهنمای کامل استفاده\n\n` +
      `<i>⚡️ قدرت‌گرفته از پروتکل RDAP، سرور 1.1.1.1 کلودفلر و معماری سرورلس تلگرام</i>`
    );
  }

  return (
    `<blockquote>🔍 <b>Host Lookup — WHOIS, DNS & Server Inspector</b></blockquote>\n\n` +
    `Fast, serverless, and privacy-first network intelligence bot.\n\n` +
    `<b>🚀 Quick Usage:</b>\n` +
    `• <b>In Private Chat:</b> Send any <b>Domain</b> (e.g. <code>google.com</code>) or <b>IP</b> (e.g. <code>1.1.1.1</code>) directly.\n` +
    `• <b>In Groups:</b> Mention the bot: <code>@HostLookupBot domain.com</code>\n` +
    `• <b>Inline Mode:</b> Type <code>@HostLookupBot </code> anywhere in Telegram!\n\n` +
    `<b>🛠 Available Commands:</b>\n` +
    `• <code>/start</code> — Main menu & bot introduction\n` +
    `• <code>/whois &lt;target&gt;</code> — Comprehensive WHOIS & server card\n` +
    `• <code>/ip &lt;address&gt;</code> — Geolocation, ASN, and hosting details\n` +
    `• <code>/dns &lt;domain&gt;</code> — Query all DNS records (A, AAAA, MX, NS, TXT)\n` +
    `• <code>/language</code> — Change language (English / فارسی)\n` +
    `• <code>/help</code> — Complete user manual & instructions\n\n` +
    `<i>⚡️ Powered by RDAP, Cloudflare 1.1.1.1 DoH & Telegram V8 Serverless</i>`
  );
}

function formatDate(isoStr) {
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.toISOString().split('T')[0];
  } catch {
    return isoStr;
  }
}

function getDaysRemaining(isoStr) {
  try {
    const target = new Date(isoStr).getTime();
    const now = Date.now();
    const diff = target - now;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

export function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
