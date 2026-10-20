import { fetch } from 'sdk';

const BASE_URL = 'https://check-host.net';

// نودهای استاندارد جهانی: ایران، اروپا، آمریکا و آسیا
const STANDARD_NODES = [
  'ir3.node.check-host.net',
  'de1.node.check-host.net',
  'us1.node.check-host.net',
  'hk1.node.check-host.net',
];

/**
 * Non-blocking delay in serverless V8 isolate via HTTP hold
 */
async function delayAsync(seconds = 2) {
  try {
    await fetch(`https://httpbin.org/delay/${seconds}`);
  } catch {}
}

/**
 * Fast single-location liveness check via Germany node
 */
export async function checkLiveness(host) {
  try {
    const clean = String(host || '').trim().replace(/^(?:https?:\/\/)/i, '').split('/')[0].split(':')[0];
    const url = `${BASE_URL}/check-ping?host=${encodeURIComponent(clean)}&node=de1.node.check-host.net`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const reqId = data.request_id;
    if (!reqId) return null;

    await delayAsync(1);

    const pollRes = await fetch(`${BASE_URL}/check-result/${reqId}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!pollRes.ok) return null;
    const pollData = await pollRes.json();
    const nodeData = pollData['de1.node.check-host.net'];
    if (nodeData && Array.isArray(nodeData) && Array.isArray(nodeData[0])) {
      const pings = nodeData[0].filter(p => Array.isArray(p) && p[0] === 'OK');
      if (pings.length > 0) {
        const avg = Math.round((pings.reduce((sum, p) => sum + p[1], 0) / pings.length) * 1000);
        return { online: true, ms: avg, node: 'Germany (Frankfurt)' };
      }
      return { online: false, ms: null, node: 'Germany (Frankfurt)' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * ایجاد درخواست پینگ در Check-Host با نودهای استاندارد جهانی
 */
export async function startPingCheck(host) {
  try {
    const nodeParams = STANDARD_NODES.map(n => `node=${encodeURIComponent(n)}`).join('&');
    const url = `${BASE_URL}/check-ping?host=${encodeURIComponent(host)}&${nodeParams}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return { error: `Check-Host API error (${res.status})` };
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * TCP port check with standard nodes
 */
export async function startTcpCheck(host, port = 443) {
  try {
    const target = `${host}:${port}`;
    const nodeParams = STANDARD_NODES.map(n => `node=${encodeURIComponent(n)}`).join('&');
    const url = `${BASE_URL}/check-tcp?host=${encodeURIComponent(target)}&${nodeParams}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return { error: `Check-Host API error (${res.status})` };
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Get Check-Host results by Request ID
 */
export async function getCheckResult(requestId) {
  try {
    const res = await fetch(`${BASE_URL}/check-result/${requestId}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/**
 * Parse ping results
 */
export function parsePingResults(nodes, results) {
  if (!results || typeof results !== 'object') return '';

  let output = '';
  let answeredCount = 0;

  for (const [nodeKey, nodeData] of Object.entries(results)) {
    if (!nodeData) continue;
    const nodeMeta = (nodes && nodes[nodeKey]) || [];
    const country = getRegionLabel(nodeKey, nodeMeta);
    const flag = getFlagEmoji(nodeMeta[0] || nodeKey.slice(0, 2));

    // Success
    if (Array.isArray(nodeData) && Array.isArray(nodeData[0])) {
      const pings = nodeData[0].filter(p => Array.isArray(p) && p[0] === 'OK');
      if (pings.length > 0) {
        const avg = Math.round((pings.reduce((sum, p) => sum + p[1], 0) / pings.length) * 1000);
        output += `${flag} <b>${country}:</b> 🟢 <code>${avg} ms</code>\n`;
        answeredCount++;
        continue;
      }
    }

    // Timeout or blocked
    output += `${flag} <b>${country}:</b> 🔴 <code>Timeout / Unreachable</code>\n`;
    answeredCount++;
  }

  return answeredCount > 0 ? output : '';
}

/**
 * Parse TCP port check results
 */
export function parseTcpResults(nodes, results) {
  if (!results || typeof results !== 'object') return '';

  let output = '';
  let answeredCount = 0;

  for (const [nodeKey, tcpList] of Object.entries(results)) {
    if (!tcpList || !Array.isArray(tcpList) || !tcpList[0]) continue;
    const sample = tcpList[0];
    const nodeMeta = (nodes && nodes[nodeKey]) || [];
    const country = getRegionLabel(nodeKey, nodeMeta);
    const flag = getFlagEmoji(nodeMeta[0] || nodeKey.slice(0, 2));

    if (sample.time !== undefined) {
      const ms = Math.round(sample.time * 1000);
      output += `${flag} <b>${country}:</b> 🟢 Open (<code>${ms} ms</code>)\n`;
      answeredCount++;
    } else if (sample.error) {
      output += `${flag} <b>${country}:</b> 🔴 Closed (<code>${sample.error}</code>)\n`;
      answeredCount++;
    }
  }

  return answeredCount > 0 ? output : '';
}

function getRegionLabel(nodeKey, nodeMeta) {
  if (nodeKey.startsWith('ir')) return 'Iran';
  if (nodeKey.startsWith('de')) return 'Europe (Germany)';
  if (nodeKey.startsWith('us')) return 'USA (Los Angeles)';
  if (nodeKey.startsWith('hk')) return 'Asia (Hong Kong)';
  return nodeMeta[1] || nodeKey.split('.')[0].toUpperCase();
}

export function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(c => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

/**
 * Curated list of high-visibility International & Iranian provincial probe nodes
 */
/**
 * 18 High-Visibility Global & Regional Probe Nodes matching standard latency matrix
 */
export const MULTI_PING_NODES = [
  // Europe & Global
  { id: 'ch1.node.check-host.net', name: 'Switzerland', code: 'ch' },
  { id: 'de1.node.check-host.net', name: 'Germany', code: 'de' },
  { id: 'es1.node.check-host.net', name: 'Spain', code: 'es' },
  { id: 'fr2.node.check-host.net', name: 'France', code: 'fr' },
  { id: 'uk1.node.check-host.net', name: 'UK', code: 'gb' },
  // Iran Provincial Hubs
  { id: 'ir2.node.check-host.net', name: 'Esfahan', code: 'ir' },
  { id: 'ir6.node.check-host.net', name: 'Karaj', code: 'ir' },
  { id: 'ir5.node.check-host.net', name: 'Mashhad', code: 'ir' },
  { id: 'ir4.node.check-host.net', name: 'Qom', code: 'ir' },
  { id: 'ir3.node.check-host.net', name: 'Shiraz', code: 'ir' },
  { id: 'ir7.node.check-host.net', name: 'Tabriz', code: 'ir' },
  { id: 'ir1.node.check-host.net', name: 'Tehran 1', code: 'ir' },
  // International Hubs
  { id: 'it2.node.check-host.net', name: 'Italy', code: 'it' },
  { id: 'nl1.node.check-host.net', name: 'Netherlands', code: 'nl' },
  { id: 'pl2.node.check-host.net', name: 'Poland', code: 'pl' },
  { id: 'ru1.node.check-host.net', name: 'Russia', code: 'ru' },
  { id: 'se1.node.check-host.net', name: 'Sweden', code: 'se' },
  { id: 'tr1.node.check-host.net', name: 'Turkey', code: 'tr' },
  { id: 'us1.node.check-host.net', name: 'USA', code: 'us' },
];

/**
 * Execute a multi-node ping check via Check-Host.net
 */
export async function runMultiPingCheck(host) {
  try {
    let clean = String(host || '').trim().replace(/^(?:https?:\/\/)/i, '').split('/')[0].split(':')[0];
    if (!clean) return { error: 'Invalid target host' };

    const nodeParams = MULTI_PING_NODES.map(n => `node=${encodeURIComponent(n.id)}`).join('&');
    let initUrl = `${BASE_URL}/check-ping?host=${encodeURIComponent(clean)}&${nodeParams}`;

    let res = await fetch(initUrl, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return { error: `Check-Host API error (${res.status})` };
    let initData = await res.json();
    let fallbackTarget = null;

    // Handle Check-Host rate limit / target cooldown
    if (initData.error === 'limit_exceeded') {
      // Smart fallback for heavily-queried 1.1.1.1 -> 1.0.0.1
      if (clean === '1.1.1.1') {
        fallbackTarget = '1.0.0.1';
        initUrl = `${BASE_URL}/check-ping?host=${encodeURIComponent(fallbackTarget)}&${nodeParams}`;
        res = await fetch(initUrl, { headers: { 'Accept': 'application/json' } });
        if (res.ok) {
          initData = await res.json();
        }
      }
    }

    if (!initData.ok || !initData.request_id) {
      if (initData.error === 'limit_exceeded') {
        return { error: 'limit_exceeded', host: clean };
      }
      return { error: initData.error || 'Failed to obtain Check-Host request ID', host: clean };
    }

    const reqId = initData.request_id;

    // Fast non-blocking delay for ICMP probes to finish across curated fast nodes
    await delayAsync(2);

    const pollRes = await fetch(`${BASE_URL}/check-result/${reqId}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!pollRes.ok) return { error: `Failed to retrieve ping results (${pollRes.status})`, host: clean };
    const results = await pollRes.json();

    return { ok: true, host: clean, fallbackTarget, reqId, results };
  } catch (err) {
    return { error: err.message || 'Unknown network error' };
  }
}

/**
 * Format Multi-Node Ping Matrix Card
 * @param {string} target 
 * @param {object} pingResult 
 * @param {object} ipData 
 * @param {string} lang 
 * @param {object} options - { expandable: boolean }
 */
export function formatMultiPingCard(target, pingResult, ipData = null, lang = 'en', options = {}) {
  const isFa = lang === 'fa';
  const cleanEscaped = String(target || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  let text = '';
  text += `📬 <b>Address:</b> <code>${cleanEscaped}</code>\n`;

  if (ipData) {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (ipData.query || ipData.ip) {
      text += `🌐 <b>IP:</b> <code>${esc(ipData.query || ipData.ip)}</code>\n`;
    }
    if (ipData.country) {
      text += `🏳️ <b>Country:</b> ${esc(ipData.country)}\n`;
    }
    if (ipData.regionName || ipData.region) {
      text += `📍 <b>Region:</b> ${esc(ipData.regionName || ipData.region)}\n`;
    }
    if (ipData.city) {
      text += `🏙️ <b>City:</b> ${esc(ipData.city)}\n`;
    }
    const asnVal = ipData.as || (ipData.asn ? `AS${ipData.asn}` : '');
    if (asnVal) {
      const match = asnVal.match(/^AS\d+/i);
      text += `🏢 <b>ASN:</b> <code>${esc(match ? match[0] : asnVal)}</code>\n`;
    }
  }

  text += `\n`;

  if (pingResult?.fallbackTarget) {
    text += isFa
      ? `💡 <i>تارگت <code>${cleanEscaped}</code> در کول‌داون سرور Check-Host بود؛ پینگ روی آی‌پی معادل (<code>${pingResult.fallbackTarget}</code>) انجام شد:</i>\n\n`
      : `💡 <i>Target <code>${cleanEscaped}</code> was on Check-Host cooldown; probed Anycast sibling (<code>${pingResult.fallbackTarget}</code>):</i>\n\n`;
  }

  if (!pingResult || pingResult.error || !pingResult.results) {
    if (pingResult?.error === 'limit_exceeded') {
      text += isFa
        ? `<blockquote>⚠️ <b>محدودیت نرخ استعلام Check-Host برای این هدف</b>\n\nاین هدف در حال حاضر بیش از حد مجاز در سرورهای جهانی تست شده و در کول‌داون موقت (۳۰ ثانیه‌ای) قرار دارد.\n💡 <i>لطفاً چند ثانیه دیگر امتحان کنید یا دامنه/آی‌پی دیگری را تست نمایید.</i></blockquote>`
        : `<blockquote>⚠️ <b>Check-Host Rate Limit Exceeded for this Target</b>\n\nThis target is heavily tested on Check-Host and is on temporary cooldown (~30s).\n💡 <i>Please retry in a moment or test another target.</i></blockquote>`;
    } else {
      text += `<blockquote>⚠️ <i>${isFa ? 'خطا در دریافت نتایج پینگ از سرورهای Check-Host.' : 'Failed to retrieve ping results from Check-Host.'}</i></blockquote>`;
    }
    return text;
  }

  const results = pingResult.results;
  const lines = [];

  for (const node of MULTI_PING_NODES) {
    const rawData = results[node.id];
    const flag = getFlagEmoji(node.code);
    const label = `${flag} ${node.name}`;

    if (!rawData || !Array.isArray(rawData) || !Array.isArray(rawData[0])) {
      lines.push(`${label} ✘ Timeout`);
      continue;
    }

    const packets = rawData[0];
    const okPackets = packets.filter(p => Array.isArray(p) && p[0] === 'OK');
    const marks = packets.map(p => (Array.isArray(p) && p[0] === 'OK') ? '✓' : '✘').join(' ');

    if (okPackets.length === 0) {
      lines.push(`${label} ✘ Timeout`);
    } else {
      const avgSec = okPackets.reduce((sum, p) => sum + p[1], 0) / okPackets.length;
      const ms = (avgSec * 1000).toFixed(1);
      lines.push(`${label} ➤ ${ms} ms [${marks}]`);
    }
  }

  const pingBlock = lines.join('\n');

  const isExpandable = options.expandable !== false;
  if (isExpandable) {
    text += `<blockquote expandable>${pingBlock}</blockquote>\n\n`;
  } else {
    text += `${pingBlock}\n\n`;
  }

  text += isFa
    ? `<i>💡 [✓ ✓ ✓ ✓] شامل ۴ پروب ICMP | <a href="tg://resolve?domain=HostLookupBot&amp;query=ping%20${cleanEscaped}">⚡️ استعلام اینلاین</a> | <code>/ping ${cleanEscaped}</code></i>`
    : `<i>💡 [✓ ✓ ✓ ✓] denotes 4 ICMP probe | <a href="tg://resolve?domain=HostLookupBot&amp;query=ping%20${cleanEscaped}">⚡️ Inline Ping</a> | <code>/ping ${cleanEscaped}</code></i>`;

  return text;
}
