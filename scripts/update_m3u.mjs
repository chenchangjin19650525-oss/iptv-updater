/**
 * IPTV 直播源自动检测更新脚本 v2
 *
 * 功能:
 * 1. 从 Gist 获取当前 M3U 播放列表
 * 2. 并行测试所有直播源连通性
 * 3. 对失效源从候选池自动替换
 * 4. 保护国内专有IP段, 防止海外运行器误判为失效
 * 5. 更新 Gist 并输出变更报告
 */

import { readFileSync, appendFileSync } from 'fs';

const GIST_ID = '90b5ba5f5591a6fd6d4e5f1b7d5cc37c';
const GIST_FILE = 'cctv.m3u';
const POOL_FILE = new URL('./sources_pool.json', import.meta.url);
const TIMEOUT_MS = 8000;
const CONCURRENCY = 15;

// ========== 国内专有IP段保护 ==========
// 以下服务器/域名仅在国内可访问, GitHub Actions海外运行器无法连接
// 标记为"国内专用", 不自动替换
const CHINA_ONLY_HOSTS = [
  '222.223.41.27',      // CCTV主源 (国内IPTV)
  '60.10.139.113',       // 河北联通IPTV备源
  '112.123.243.37',      // 山西联通IPTV (已废弃,但保留规则)
  '222.214.208.34',      // 四川联通IPTV
  '123.129.70.178',      // 山东联通IPTV
  '119.39.9.8',          // 山西联通IPTV
  '116.128.243.121',     // 联通IPTV通用
  '36.32.174.67',        // 山东联通IPTV
  '58.56.162.102',       // 山东联通IPTV
  '222.169.85.8',        // 吉林联通IPTV
  '112.27.235.94',       // 安徽联通IPTV
  '221.226.51.220',      // 江苏电信IPTV
  '120.198.95.220',      // 广东移动IPTV
  '124.228.160.176',     // 湖南移动IPTV
  '218.13.170.98',       // 广东电信IPTV
  '39.165.39.49',        // 移动IPTV
  '113.25.252.226',      // 河南联通IPTV
  '120.202.94.181',      // 湖北IPTV
  '153.0.171.163',       // 联通IPTV
  '120.211.62.180',      // 云南IPTV
  '198.204.228.26',      // CDN (可能海外可访问)
  '192.151.150.154',     // CDN (可能海外可访问)
  '207.56.13.146',       // CDN (可能海外可访问)
  '63.141.230.178',      // CDN (可能海外可访问)
  '38.75.136.137',       // CDN (可能海外可访问)
  '107.150.60.122',      // CDN (可能海外可访问)
];

function isChinaOnly(url) {
  try {
    const host = new URL(url).hostname;
    return CHINA_ONLY_HOSTS.some(h => host.includes(h));
  } catch {
    return false;
  }
}

// 官方CDN域名 — 全球可访问, 优先保留
const GLOBAL_CDN_HOSTS = [
  'bestv.cn', 'bestv.com.cn',
  'cztv.com', 'ali-m-l.cztv.com', 'ali-xwl.cztv.com', 'l.cztvcloud.com',
  'hljtv.com',
  'hebtv.com',
  'dxhmt.cn',
  'yntv.net',
  'cnr.cn', 'satellitepull.cnr.cn',
  'mgtv.com', 'qing.mgtv.com',
  'zohi.tv',
  'iyb983.cn',
  'hkstv.tv', 'webcast.hkstv.tv',
  'wjyanghu.com',
  'cssbyd.imwork.net',
  'tv1288.xyz',
  'kan0512.com',
  'sdetv.com.cn',
  'live.zbds.top',
];

function isGlobalCDN(url) {
  try {
    const host = new URL(url).hostname;
    return GLOBAL_CDN_HOSTS.some(h => host.includes(h));
  } catch {
    return false;
  }
}

// ========== 工具函数 ==========

async function testUrl(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const reader = resp.body.getReader();
    let text = '';
    try {
      while (text.length < 1024) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        text += new TextDecoder().decode(value);
        if (text.length >= 1024) break;
      }
      reader.cancel();
    } catch { reader.cancel(); }
    const isM3u = text.includes('#EXTM3U') || text.includes('#EXTINF') || text.includes('#EXT-X-STREAM');
    return { ok: true, isM3u, size: text.length };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, reason: e.name === 'AbortError' ? 'TIMEOUT' : e.message.slice(0, 60) };
  }
}

async function ghApi(endpoint, options = {}) {
  const token = process.env.GIST_TOKEN;
  if (!token) throw new Error('GIST_TOKEN 环境变量未设置');
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com/${endpoint}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// ========== M3U 解析 ==========

function parseM3u(content) {
  const lines = content.split('\n');
  const entries = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXTINF:')) {
      const groupMatch = trimmed.match(/group-title="([^"]+)"/);
      const nameMatch = trimmed.match(/,([^,]+)$/);
      current = {
        extinf: trimmed,
        group: groupMatch ? groupMatch[1] : '',
        name: nameMatch ? nameMatch[1].trim() : '',
        rawUrl: ''
      };
    } else if (trimmed && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
      if (current) {
        current.rawUrl = trimmed;
        entries.push(current);
        current = null;
      }
    }
  }
  return entries;
}

function rebuildM3u(entries) {
  const header = `#EXTM3U x-tvg-url="https://epg.deny.vip/sh/tel-epg.xml"
#PLAYLIST: CCTV + 卫视频道 直播源 (自动维护, GitHub Actions每日检测)
#最后检测: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC
#CCTV主源: 222.223.41.27:8888 (国内专用) 备源: 60.10.139.113:8801 (国内专用)
#卫视频道自动检测替换, 候选池: sources_pool.json
`;
  const groups = {};
  for (const e of entries) {
    if (!groups[e.group]) groups[e.group] = [];
    groups[e.group].push(e);
  }

  const order = ['央视频道', '央视频道(备)', '卫视频道', '卫视频道(备)'];
  let out = header;
  for (const g of order) {
    if (groups[g]) {
      out += `\n# ==================== ${g} ====================\n\n`;
      for (const e of groups[g]) {
        out += `${e.extinf}\n${e.rawUrl}\n\n`;
      }
    }
  }
  return out.trimEnd() + '\n';
}

// ========== 主流程 ==========

async function main() {
  console.log('=== IPTV 直播源自动检测 v2 ===');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`注意: 运行器在海外, 国内专有IP段不可达属正常现象\n`);

  // 1. 获取当前 Gist 内容
  console.log('[1/5] 获取当前 Gist 播放列表...');
  const gist = await ghApi(`gists/${GIST_ID}`);
  const currentContent = gist.files?.[GIST_FILE]?.content;
  if (!currentContent) throw new Error('无法获取 Gist 文件内容');

  const entries = parseM3u(currentContent);
  console.log(`  解析到 ${entries.length} 个频道条目`);

  // 统计源类型
  const chinaCount = entries.filter(e => isChinaOnly(e.rawUrl)).length;
  const globalCount = entries.filter(e => isGlobalCDN(e.rawUrl)).length;
  console.log(`  国内专用源: ${chinaCount} | 全球CDN源: ${globalCount} | 其他: ${entries.length - chinaCount - globalCount}\n`);

  // 2. 加载候选源池
  console.log('[2/5] 加载候选源池...');
  const pool = JSON.parse(readFileSync(POOL_FILE, 'utf-8'));

  // 3. 并行测试所有 URL
  console.log(`[3/5] 并行测试 ${entries.length} 个源 (并发${CONCURRENCY})...`);
  const testResults = [];
  const queue = [...entries];

  async function worker() {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) break;
      const result = await testUrl(entry.rawUrl);
      testResults.push({ entry, result });
      const icon = result.ok ? '✓' : (isChinaOnly(entry.rawUrl) ? '⊘' : '✗');
      const note = (!result.ok && isChinaOnly(entry.rawUrl)) ? '(国内专用,跳过替换)' : '';
      console.log(`  ${icon} ${entry.name.padEnd(12)} ${result.ok ? 'OK' : result.reason + ' ' + note}`);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  // 4. 智能替换失效源 (跳过国内专用源)
  console.log('\n[4/5] 智能替换失效源...');
  const failed = testResults.filter(r => !r.result.ok);
  const chinaUnreachable = failed.filter(r => isChinaOnly(r.entry.rawUrl));
  const trulyFailed = failed.filter(r => !isChinaOnly(r.entry.rawUrl));

  if (chinaUnreachable.length > 0) {
    console.log(`  ⊘ ${chinaUnreachable.length} 个国内专用源在海外不可达, 保留不替换`);
  }

  let replaced = 0;
  const changes = [];

  for (const { entry } of trulyFailed) {
    console.log(`\n  处理: ${entry.name} (${entry.rawUrl.slice(0, 60)}...)`);
    const candidates = pool.channels[entry.name];
    if (!candidates || candidates.length === 0) {
      console.log(`  ⚠ 无候选源, 保留原URL`);
      changes.push(`⚠ ${entry.name}: 无候选源, 保留原URL`);
      continue;
    }

    // 优先选全球CDN候选, 再选IPTV候选
    const sorted = [...candidates].sort((a, b) => {
      const aGlobal = isGlobalCDN(a) ? 0 : 1;
      const bGlobal = isGlobalCDN(b) ? 0 : 1;
      return aGlobal - bGlobal;
    });

    let found = false;
    for (const candidate of sorted) {
      if (candidate === entry.rawUrl) continue;
      console.log(`  尝试: ${candidate.slice(0, 70)}...`);
      const r = await testUrl(candidate);
      if (r.ok) {
        const oldUrl = entry.rawUrl;
        entry.rawUrl = candidate;
        replaced++;
        changes.push(`✓ ${entry.name}: ${oldUrl.slice(0, 50)} → ${candidate.slice(0, 50)}`);
        console.log(`  ✓ 已替换`);
        found = true;
        break;
      } else {
        console.log(`  ✗ 候选失败: ${r.reason}`);
      }
    }
    if (!found) {
      console.log(`  ⚠ ${entry.name}: 所有${sorted.length}个候选源均失效, 保留原URL`);
      changes.push(`⚠ ${entry.name}: ${sorted.length}个候选源均失效`);
    }
  }

  // 5. 更新 Gist
  console.log(`\n[5/5] 更新 Gist...`);
  if (replaced > 0) {
    const newContent = rebuildM3u(entries);
    await ghApi(`gists/${GIST_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({
        files: { [GIST_FILE]: { content: newContent } },
        description: `CCTV + 卫视频道 直播源 (${new Date().toISOString().slice(0, 10)}自动更新)`
      })
    });
    console.log(`  ✓ Gist已更新, 替换了 ${replaced} 个失效源`);
  } else {
    console.log('  ✓ 无需更新, 所有全球源正常');
  }

  // 输出报告
  const totalTested = testResults.length;
  const totalOk = totalTested - failed.length;
  console.log('\n' + '='.repeat(60));
  console.log('=== 检测报告 ===');
  console.log(`总频道: ${totalTested} | ✅全球可达: ${totalOk} | ❌失效: ${trulyFailed.length} | ⊘国内专用: ${chinaUnreachable.length} | 🔄已修复: ${replaced}`);
  if (changes.length > 0) {
    console.log('\n变更详情:');
    changes.forEach(c => console.log(`  ${c}`));
  }

  // GitHub Actions Step Summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## 📡 IPTV 源检测报告`,
      `- 🕐 检测时间: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
      `- 📊 总频道: ${totalTested} | ✅ 正常: ${totalOk} | ❌ 全球失效: ${trulyFailed.length} | 🇨🇳 国内专用: ${chinaUnreachable.length} | 🔄 已修复: ${replaced}`,
      ``,
    ];
    if (chinaUnreachable.length > 0) {
      lines.push(`### 🇨🇳 国内专用源 (海外不可达, 已保护保留)`);
      chinaUnreachable.forEach(r => lines.push(`- ⊘ ${r.entry.name}`));
      lines.push('');
    }
    if (changes.length > 0) {
      lines.push(`### 🔄 变更详情`);
      changes.forEach(c => lines.push(`- ${c}`));
    }
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

main().catch(e => {
  console.error('执行失败:', e.message);
  process.exit(1);
});
