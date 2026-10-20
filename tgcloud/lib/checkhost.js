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

    await new Promise(r => setTimeout(r, 1100));

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

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(c => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}
