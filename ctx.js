#!/usr/bin/env node
/**
 * DSH 上下文检索工具 (context-search)
 * 用途：从 DSH 会话记录（zstd 多帧 JSONL）中快速检索历史上下文
 *
 * 用法：
 *   node ctx.js list                      列出所有会话（按大小/时间）
 *   node ctx.js search "关键词" [--sess=ID] [--limit=20] [--before=N]
 *   node ctx.js tail [--sess=ID] [--n=10]  看某会话最后 N 条
 *   node ctx.js stats                       统计各会话
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Session root: override with --root=PATH or CTX_SEARCH_ROOT env var.
// Defaults cover common agent-runtime locations on each platform.
const os = require('os');
function defaultRoot() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.dsh', 'sessions'),
    path.join(home, '.config', 'dsh', 'sessions'),
    path.join(home, 'Library', 'Application Support', 'dsh', 'sessions'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}
function getRoot() { return process.env.CTX_SEARCH_ROOT || defaultRoot(); }

function listSessions() {
  const out = [];
  for (const dir of fs.readdirSync(getRoot(), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const base = path.join(getRoot(), dir.name);
    for (const sub of fs.readdirSync(base, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const f = path.join(base, sub.name, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      const st = fs.statSync(f);
      out.push({ id: sub.name, file: f, size: st.size, mtime: st.mtimeMs, workspace: dir.name });
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

/** 多帧 zstd 解压 → 字符串 */
function decompressAll(file) {
  const buf = fs.readFileSync(file);
  const chunks = [];
  let pos = 0;
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  while (pos < buf.length) {
    const next = buf.indexOf(MAGIC, pos + 4);
    const end = next === -1 ? buf.length : next;
    const frame = buf.slice(pos, end);
    try {
      chunks.push(zlib.zstdDecompressSync(frame));
    } catch (e) {
      // 帧损坏则跳过剩余
      break;
    }
    pos = end;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 解析 JSONL → 消息数组 */
function parseMessages(text) {
  const msgs = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'session') continue;
    msgs.push(o);
  }
  return msgs;
}

/** 提取可检索文本（含 data 内所有字符串） */
function extractText(o) {
  const parts = [];
  const walk = (v, depth) => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') { if (v.length < 20000) parts.push(v); return; }
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (k === 'type' || k === 'seq' || k === 'time') continue;
        walk(v[k], depth + 1);
      }
    }
  };
  walk(o && o.data !== undefined ? o.data : o, 0);
  return parts.join(' ');
}

function cmdList() {
  const ss = listSessions();
  console.log('会话列表（按大小排序）:');
  console.log('大小(MB)  修改时间            会话ID                              工作区');
  for (const s of ss.slice(0, 30)) {
    const mb = (s.size / 1048576).toFixed(1).padStart(7);
    const t = new Date(s.mtime).toLocaleString('zh-CN', { hour12: false });
    console.log(`${mb}  ${t}  ${s.id.slice(0, 36).padEnd(38)} ${s.workspace.slice(0, 30)}`);
  }
}

function getSessionFile(sessId) {
  const ss = listSessions();
  if (!ss.length) {
    console.error('No session archives found under: ' + getRoot());
    console.error('Set CTX_SEARCH_ROOT or --root=PATH to point at your agent session directory.');
    console.error('Try the bundled demo: CTX_SEARCH_ROOT=./examples node ctx.js list');
    process.exit(1);
  }
  if (sessId) {
    const hit = ss.find(s => s.id.includes(sessId));
    if (!hit) { console.error('Session not found:', sessId); process.exit(1); }
    return hit;
  }
  return ss[0]; // 默认最大的（= 主会话）
}

function cmdSearch(kw, opts) {
  const s = getSessionFile(opts.sess);
  if (!kw) { console.error('用法: search "关键词"'); process.exit(1); }
  const text = decompressAll(s.file);
  const msgs = parseMessages(text);
  const limit = Number(opts.limit || 20);
  const hits = [];
  msgs.forEach((m, i) => {
    const t = extractText(m);
    if (t && t.toLowerCase().includes(kw.toLowerCase())) {
      hits.push({ i, t });
    }
  });
  console.log(`会话 ${s.id.slice(0, 20)}… | 消息 ${msgs.length} 条 | 命中 "${kw}" ${hits.length} 处`);
  console.log('='.repeat(70));
  const show = opts.before ? hits.slice(0, Number(opts.before)) : hits.slice(-limit);
  for (const h of show) {
    const t = h.t.replace(/\s+/g, ' ').slice(0, 400);
    const idx = t.toLowerCase().indexOf(kw.toLowerCase());
    const st = Math.max(0, idx - 120);
    console.log(`\n[#${h.i}] …${t.slice(st, st + 400)}…`);
  }
  if (hits.length > show.length) console.log(`\n（共 ${hits.length} 处，显示 ${show.length}）`);
}

function cmdTail(opts) {
  const s = getSessionFile(opts.sess);
  const n = Number(opts.n || 10);
  const msgs = parseMessages(decompressAll(s.file));
  console.log(`会话 ${s.id.slice(0, 20)}… 最后 ${n} 条：\n`);
  for (const m of msgs.slice(-n)) {
    console.log(extractText(m).replace(/\s+/g, ' ').slice(0, 300) + '\n');
  }
}

function cmdStats() {
  const ss = listSessions();
  let total = 0;
  for (const s of ss) total += s.size;
  console.log(`共 ${ss.length} 个会话，合计 ${(total / 1048576).toFixed(1)} MB`);
  console.log('最大的 5 个:');
  for (const s of ss.slice(0, 5)) {
    console.log(`  ${(s.size / 1048576).toFixed(1)} MB  ${s.id.slice(0, 36)}`);
  }
}

// main
const [, , cmd, ...args] = process.argv;
// allow --root=PATH to override the session root before anything else reads it
for (const a of args) if (a.startsWith('--root=')) process.env.CTX_SEARCH_ROOT = a.slice(7);
const opts = {};
let kw = '';
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    opts[k] = v ?? true;
  } else kw = a;
}
try {
  if (cmd === 'list') cmdList();
  else if (cmd === 'search') cmdSearch(kw, opts);
  else if (cmd === 'tail') cmdTail(opts);
  else if (cmd === 'stats') cmdStats();
  else console.log('用法: node ctx.js [list|search "kw"|tail|stats] [--sess=ID] [--limit=N]');
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
