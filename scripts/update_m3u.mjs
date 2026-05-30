/**
 * IPTV 直播源自动检测更新脚本
 *
 * 功能:
 * 1. 从 Gist 获取当前 M3U 播放列表
 * 2. 并行测试所有直播源连通性
 * 3. 对失效源从候选池自动替换
 * 4. 更新 Gist 并输出变更报告
 */

import { readFileSync } from 'fs';

const GIST_ID = '90b5ba5f5591a6fd6d4e5f1b7d5cc37c';
const GIST_FILE = 'cctv.m3u';
const POOL_FILE = new URL('./sources_pool.json', import.meta.url);
const TIMEOUT_MS = 8000;
const CONCURRENCY = 20;

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
#PLAYLIST: CCTV + 卫视频道 直播源 (自动维护)
#最后检测: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC
#CCTV主源: 222.223.41.27:8888 备源: 60.10.139.113:8801
#卫视频道自动检测替换, 候选池维护于 sources_pool.json
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
  console.log('=== IPTV 直播源自动检测 ===');
  console.log(`时间: ${new Date().toISOString()}\n`);

  // 1. 获取当前 Gist 内容
  console.log('[1/5] 获取当前 Gist 播放列表...');
  const gist = await ghApi(`gists/${GIST_ID}`);
  const currentContent = gist.files?.[GIST_FILE]?.content;
  if (!currentContent) throw new Error('无法获取 Gist 文件内容');

  const entries = parseM3u(currentContent);
  console.log(`  解析到 ${entries.length} 个频道条目`);

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
      const icon = result.ok ? '✓' : '✗';
      console.log(`  ${icon} ${entry.name.padEnd(10)} ${result.ok ? 'OK' : result.reason}`);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  // 4. 替换失效源
  console.log('\n[4/5] 替换失效源...');
  const failed = testResults.filter(r => !r.result.ok);
  let replaced = 0;
  const changes = [];

  for (const { entry } of failed) {
    const candidates = pool.channels[entry.name];
    if (!candidates || candidates.length === 0) {
      console.log(`  ⚠ ${entry.name}: 无候选源可替换`);
      changes.push(`⚠ ${entry.name}: 无候选源, 保留原URL`);
      continue;
    }

    // 找第一个不同于当前 URL 且可用的候选
    let found = false;
    for (const candidate of candidates) {
      if (candidate === entry.rawUrl) continue; // 跳过当前(已失效)的
      console.log(`  尝试 ${entry.name}: ${candidate.slice(0, 60)}...`);
      const r = await testUrl(candidate);
      if (r.ok) {
        const oldUrl = entry.rawUrl;
        entry.rawUrl = candidate;
        replaced++;
        changes.push(`✓ ${entry.name}: ${oldUrl.slice(0,50)} → ${candidate.slice(0,50)}`);
        console.log(`  ✓ ${entry.name} 已替换`);
        found = true;
        break;
      } else {
        console.log(`  ✗ 候选失败: ${r.reason}`);
      }
    }
    if (!found) {
      console.log(`  ⚠ ${entry.name}: 所有候选源均失效`);
      changes.push(`⚠ ${entry.name}: ${candidates.length}个候选源均失效`);
    }
  }

  // 5. 更新 Gist
  console.log(`\n[5/5] 更新 Gist...`);
  if (replaced > 0) {
    const newContent = rebuildM3u(entries);
    await ghApi(`gists/${GIST_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({
        files: { [GIST_FILE]: { content: newContent } }
      })
    });
    console.log(`  ✓ 已更新, 替换了 ${replaced} 个失效源`);
  } else {
    console.log('  无需更新, 所有源正常');
  }

  // 输出报告
  console.log('\n=== 检测报告 ===');
  const totalTested = testResults.length;
  const totalOk = totalTested - failed.length;
  console.log(`总频道: ${totalTested} | 正常: ${totalOk} | 失效: ${failed.length} | 已修复: ${replaced}`);
  if (changes.length > 0) {
    console.log('\n变更详情:');
    changes.forEach(c => console.log(`  ${c}`));
  }

  // 输出 GitHub Actions 摘要
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      `## IPTV 源检测报告`,
      `- 检测时间: ${new Date().toISOString()}`,
      `- 总频道: ${totalTested} | ✅正常: ${totalOk} | ❌失效: ${failed.length} | 🔄已修复: ${replaced}`,
      '',
    ];
    if (changes.length > 0) {
      summary.push('### 变更详情');
      changes.forEach(c => summary.push(`- ${c}`));
    }
    const fs = await import('fs');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  }
}

main().catch(e => {
  console.error('执行失败:', e.message);
  process.exit(1);
});
