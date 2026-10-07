/*
 * tools/verify.js — 离线验证 Loon / Shadowrocket 两个平台的插件与脚本
 *
 * 用法:  node tools/verify.js
 * 覆盖:
 *   1. 每个 script-path 的文件名在仓库里真实存在(防止改名后静默 404)
 *   2. Loon 侧与 Shadowrocket 侧脚本字节一致(防漂移)
 *   3. 模块/插件里 pattern 正则对样例 URL 命中/不命中
 *   4. 脚本 harness:参数 4 种形态(JSON 字符串 / 具名对象 / 位置数组 / 缺失) x 正常/异常输入
 *   5. 负对照:未打兼容补丁的旧脚本遇到 Shadowrocket 的 JSON 字符串参数时必须失败
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let checks = 0, failures = [];
function ok(cond, label) { checks++; if (!cond) failures.push(label); }
function eq(a, b, label) { ok(a === b, label + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* ---------------- 1. 清单 / 脚本名一致性 ---------------- */
const MANIFEST = [
  ['loon/Discord.Translate.plugin', ['translate-response.js']],
  ['Shadowrocket/Discord.Translate.module', ['translate-response.sr.js']],
  ['loon/fake-nitro.plugin', ['fake-nitro-display.js', 'fakenitro-send.js', 'fakenitro-catalog.js', 'blocklist-record.js']],
  ['Shadowrocket/fake-nitro.module', ['fake-nitro-display.sr.js', 'fakenitro-send.sr.js', 'fakenitro-catalog.sr.js', 'blocklist-record.sr.js']],
];

const repoFiles = new Set();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else repoFiles.add(path.relative(ROOT, p).split(path.sep).join('/'));
  }
})(ROOT);

const scriptRefs = [];
for (const [file, expected] of MANIFEST) {
  ok(fs.existsSync(path.join(ROOT, file)), '清单文件缺失: ' + file);
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const refs = [...text.matchAll(/script-path=([^,\s]+)/g)].map(m => m[1]);
  ok(refs.length > 0, file + ' 没有任何 script-path');
  for (const r of refs) {
    const base = r.split('?')[0].split('/').pop();
    ok(expected.includes(base), file + ' 引用了非预期的脚本名: ' + base);
    scriptRefs.push(base);
  }
}
for (const base of new Set(scriptRefs)) {
  const found = [...repoFiles].filter(f => f.split('/').pop() === base);
  eq(found.length, 1, '脚本名 ' + base + ' 在仓库里应恰好出现 1 次, 实际 ' + found.length + ': ' + found.join(', '));
}

/* ---------------- 2. Loon / Shadowrocket 脚本一致性 ---------------- */
const PAIRS = [
  ['loon/translate-response.js', 'Shadowrocket/translate-response.sr.js'],
  ['loon/fake-nitro-display.js', 'Shadowrocket/fake-nitro-display.sr.js'],
  ['loon/fakenitro-send.js', 'Shadowrocket/fakenitro-send.sr.js'],
  ['loon/fakenitro-catalog.js', 'Shadowrocket/fakenitro-catalog.sr.js'],
  ['loon/blocklist-record.js', 'Shadowrocket/blocklist-record.sr.js'],
];
// 两平台允许的显式差异(必须在这里逐条列出;除此之外任何差异都算漂移):
//   1) Shadowrocket 侧脚本外层包 IIFE
//   2) Shadowrocket 侧的 $httpClient 额外带 opts.policy = "DIRECT"
//   3) Shadowrocket 侧多一行 var CALL_BUDGET(重复声明, 无害)
function normPlatform(s) {
  return s.replace(/\r\n/g, '\n')
    .replace(/^\(function \(\) \{\n/, '')
    .replace(/\n\}\)\(\);\s*$/, '\n')
    .replace(/if \(lanDirect\(url\)\) \{ opts\.node = "DIRECT"; opts\.policy = "DIRECT"; \}/g,
      'if (lanDirect(url)) opts.node = "DIRECT";')
    .replace(/^\s*var CALL_BUDGET = num\(CFG\.maxcalls, 16\);\n(?=\s*var effBudget)/m, '');
}
for (const [a, b] of PAIRS) {
  if (!fs.existsSync(path.join(ROOT, a)) || !fs.existsSync(path.join(ROOT, b))) { ok(false, '缺文件: ' + a + ' / ' + b); continue; }
  const A = normPlatform(fs.readFileSync(path.join(ROOT, a), 'utf8'));
  const B = normPlatform(fs.readFileSync(path.join(ROOT, b), 'utf8'));
  ok(A === B, a + ' 与 ' + b + ' 去掉「已声明的平台差异」后仍不一致(说明有一侧被单边改动了)');
}

/* 分离边界: 翻译脚本保持精简, 不复用 FakeNitro 的目录/黑名单实现, 不发通知。 */
for (const file of ['loon/translate-response.js', 'Shadowrocket/translate-response.sr.js']) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  ok(text.indexOf('fakenitro_emoji_catalog') === -1, file + ' 不应包含 FakeNitro 目录逻辑');
  ok(text.indexOf('discord_blocked_users') === -1, file + ' 不应包含 FakeNitro 黑名单逻辑');
  ok(text.indexOf('$notification.post') === -1, file + ' 不应再发翻译通知');
}

/* 校验器自检: 平台差异归一化不能把真实改动一起吞掉 */
{
  const base = fs.readFileSync(path.join(ROOT, 'loon/translate-response.js'), 'utf8');
  ok(normPlatform(base) !== normPlatform(base.replace('var GG_HOSTS = [', 'var GG_HOSTS_BROKEN = [')),
    '一致性校验器自检失败: 真实改动被平台差异归一化吞掉了');
}

/* ---------------- 2b. 参数契约: ARG_ORDER <-> [Argument] <-> argument=[{..}] / k=v ---------------- */
{
  const scriptText = fs.readFileSync(path.join(ROOT, 'loon/translate-response.js'), 'utf8');
  const am = scriptText.match(/var ARG_ORDER = \[([\s\S]*?)\];/);
  ok(!!am, '脚本里找不到 ARG_ORDER');
  const argOrder = am ? [...am[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map(x => x[1]) : [];
  ok(argOrder.length >= 10, 'ARG_ORDER 解析异常: ' + argOrder.join(','));
  const sameSet = (a, b) => a.slice().sort().join(',') === b.slice().sort().join(',');
  ok(!sameSet(argOrder.slice(1), argOrder), '参数契约校验器自检失败: 少一个参数竟然通过');

  const pluginText = fs.readFileSync(path.join(ROOT, 'loon/Discord.Translate.plugin'), 'utf8');
  const declared = [];
  let inArg = false;
  for (const line of pluginText.split('\n')) {
    const s = line.trim();
    if (/^\[/.test(s)) { inArg = /^\[Argument\]/i.test(s); continue; }
    if (!inArg || !s || s.startsWith('#')) continue;
    const nm = s.match(/^([A-Za-z0-9_]+)\s*=/);
    if (nm) declared.push(nm[1]);
  }
  ok(sameSet(declared, argOrder), 'Loon [Argument] 与脚本 ARG_ORDER 不一致:\n      Argument=' + declared.join(',') + '\n      ARG_ORDER=' + argOrder.join(','));
  let argRules = 0;
  for (const line of pluginText.split('\n')) {
    const mm = line.match(/argument=\[([^\]]*)\]/);
    if (!mm) continue;
    argRules++;
    const ph = [...mm[1].matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(x => x[1]);
    ok(sameSet(ph, argOrder), 'Loon 规则 argument=[...] 与 ARG_ORDER 不一致: ' + ph.join(','));
  }
  eq(argRules, 3, 'Loon 翻译规则数(argument=[...])');

  const modText = fs.readFileSync(path.join(ROOT, 'Shadowrocket/Discord.Translate.module'), 'utf8');
  let kvRules = 0;
  for (const line of modText.split('\n')) {
    const s = line.trim();
    if (!/type=http-(?:response|request)/.test(s)) continue;
    const a = (s.match(/argument=(.*)$/) || [])[1];
    if (a === undefined) continue;
    kvRules++;
    const keys = a.split('&').filter(Boolean).map(p => p.slice(0, p.indexOf('=')));
    ok(sameSet(keys, argOrder), 'Shadowrocket 规则 k=v 与 ARG_ORDER 不一致: ' + keys.join(','));
  }
  eq(kvRules, 3, 'Shadowrocket 翻译规则数(argument=k=v)');

  /* SR 可视化参数面板: #!arguments 声明 <-> 正文 {{{占位符}}} <-> ARG_ORDER (SR 官方「编辑参数」机制) */
  {
    const decl = (modText.match(/^#!arguments=(.*)$/m) || [])[1];
    ok(!!decl, 'Shadowrocket 模块缺 #!arguments 声明(可视化「编辑参数」面板不显示)');
    const declNames = decl ? decl.split(',').map(p => p.split(':')[0].trim()).filter(Boolean) : [];
    // 只扫非注释行;收集 argument= 里的 k={{{显示名}}} 配对(内部键 <-> 面板显示名的真实映射)
    const pairs = [];
    for (const line of modText.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      if (!/type=http-(?:response|request)/.test(s)) continue;
      const a = (s.match(/argument=(.*)$/) || [])[1];
      if (a === undefined) continue;
      for (const m of a.matchAll(/([A-Za-z0-9_]+)=\{\{\{([^}]+)\}\}\}/g)) pairs.push([m[1], m[2].trim()]);
      ok(a.indexOf('{{{') !== -1, 'Shadowrocket 规则 argument 应使用 {{{参数}}} 占位符(可视化面板才生效): ' + s.slice(0, 60));
    }
    const keys = [...new Set(pairs.map(p => p[0]))];
    const names = [...new Set(pairs.map(p => p[1]))];
    ok(names.length > 0, 'Shadowrocket 模块正文没有 {{{参数}}} 占位符(面板改了不生效)');
    ok(sameSet(keys, argOrder), 'argument 里 k={{{名}}} 的内部键与 ARG_ORDER 不一致:\n      键=' + keys.join(',') + '\n      ARG_ORDER=' + argOrder.join(','));
    ok(sameSet(names, declNames), '#!arguments 显示名与 argument 占位符不一致:\n      arguments=' + declNames.join(',') + '\n      占位符=' + names.join(','));
    eq(pairs.length, argOrder.length * 3, 'k={{{名}}} 配对总数应为 参数数×3 条规则, 实际 ' + pairs.length);
  }
}

/* ---------------- 3. pattern 正则自检 ---------------- */
const PATTERN_CASES = [
  ['Shadowrocket/Discord.Translate.module', 'Translate 响应',
    ['https://discord.com/api/v9/channels/123456789/messages?limit=25',
      'https://discordapp.com/api/v10/channels/1/messages'],
    ['https://discord.com/api/v9/channels/1/threads/search?limit=25',
      'https://discord.com/api/v9/users/1/profile']],
  ['Shadowrocket/Discord.Translate.module', 'Translate 论坛搜索',
    ['https://discord.com/api/v9/channels/1/threads/search?limit=25'],
    ['https://discord.com/api/v9/channels/1/messages']],
  ['Shadowrocket/Discord.Translate.module', 'Translate 论坛首楼',
    ['https://discord.com/api/v9/channels/1/post-data'],
    ['https://discord.com/api/v9/channels/1/messages']],
  ['Shadowrocket/fake-nitro.module', 'Nitro Display',
    ['https://discord.com/api/v9/users/123/profile',
      'https://discord.com/api/v9/users/123/profile?with_mutual_guilds=true'],
    ['https://discord.com/api/v9/users/@me/entitlements',
      'https://discord.com/api/v9/channels/1/messages']],
  ['Shadowrocket/fake-nitro.module', 'Nitro Entitlements',
    ['https://discord.com/api/v9/users/@me/entitlements'],
    ['https://discord.com/api/v9/users/@me/entitlements/foo']],
  ['loon/Discord.Translate.plugin', 'Translate 响应',
    ['https://discord.com/api/v9/channels/123456789/messages?limit=25'],
    ['https://discord.com/api/v9/users/1/profile']],
  ['loon/Discord.Translate.plugin', 'Translate 论坛搜索',
    ['https://discord.com/api/v9/channels/1/threads/search?limit=25'],
    ['https://discord.com/api/v9/channels/1/messages']],
  ['loon/Discord.Translate.plugin', 'Translate 论坛首楼',
    ['https://discord.com/api/v9/channels/1/post-data'],
    ['https://discord.com/api/v9/channels/1/messages']],
  ['loon/fake-nitro.plugin', 'Nitro Display',
    ['https://discord.com/api/v9/users/123/profile'],
    ['https://discord.com/api/v9/users/@me/entitlements']],
  ['loon/fake-nitro.plugin', 'Nitro Entitlements',
    ['https://discord.com/api/v9/users/@me/entitlements'],
    ['https://discord.com/api/v9/users/@me/entitlements/foo']],
  ['loon/fake-nitro.plugin', 'FakeNitro Emoji Directory',
    ['https://discord.com/api/v9/guilds/123/top-emojis',
      'https://discord.com/api/v9/emojis'],
    ['https://discord.com/api/v9/channels/1/messages']],
  ['Shadowrocket/fake-nitro.module', 'FakeNitro Emoji Directory',
    ['https://discord.com/api/v9/guilds/123/top-emojis',
      'https://discord.com/api/v9/emojis'],
    ['https://discord.com/api/v9/channels/1/messages']],
];

function patternOf(file, tag) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const isPlugin = /\.plugin$/.test(file);
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    let name = null, pat = null;
    if (isPlugin) {
      const m = s.match(/^http-(?:response|request)\s+(\S+)/);
      if (!m) continue;
      pat = m[1];
      name = (s.match(/tag=([^,]+)/) || [])[1];
    } else {
      const m = s.match(/pattern=([^,]+)/);
      if (!m) continue;
      pat = m[1].trim();
      name = s.split('=')[0].trim();
    }
    if (name && name.trim() === tag) return pat;
  }
  return null;
}
for (const [file, tag, yes, no] of PATTERN_CASES) {
  const p = patternOf(file, tag);
  if (!p) { ok(false, file + ' 找不到规则 ' + tag); continue; }
  let re;
  try { re = new RegExp(p); } catch (e) { ok(false, file + ' / ' + tag + ' 正则无法编译: ' + e.message); continue; }
  for (const u of yes) ok(re.test(u), file + ' / ' + tag + ' 未命中: ' + u);
  for (const u of no) ok(!re.test(u), file + ' / ' + tag + ' 误命中: ' + u);
}
// 校验器自身的负对照:坏正则必须能被这套断言抓到
{
  const bad = 'pattern=^https?:\\/\\/discord\\.com\\/messages';
  const m = bad.match(/pattern=([^,]+)/);
  const re = new RegExp(m[1]);
  ok(!re.test('https://discord.com/api/v9/channels/1/messages'), '正则自检失效: 坏正则竟然命中了样例 URL');
}

/* ---------------- 3b. .module 语法 lint(Shadowrocket 专有坑) ---------------- */
for (const file of ['Shadowrocket/Discord.Translate.module', 'Shadowrocket/fake-nitro.module']) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const lines = text.split('\n');
  let mitmSeen = false, ruleSeen = 0;
  let inMitm = false;
  for (const raw of lines) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    if (/^\[/.test(s)) { inMitm = /^\[MITM\]/.test(s); continue; }
    if (inMitm) { mitmSeen = true; ok(s.indexOf('%APPEND%') !== -1, file + ' [MITM] 缺 %APPEND%(会覆盖配置里其他模块的解密域名): ' + s); continue; }
    if (!/type=http-(?:response|request)/.test(s)) continue;
    ruleSeen++;
    const arg = (s.match(/argument=(.*)$/) || [])[1];
    if (arg !== undefined) {
      // Shadowrocket 的 argument 是 k=v&k=v;出现 {} 或 , 会把这一行的属性切碎
      // {{{参数}}} 占位符(可视化「编辑参数」面板)是唯一合法的花括号, 剥掉后再查
      const stripped = arg.replace(/\{\{\{[^}]*\}\}\}/g, 'PH');
      ok(stripped.indexOf('{') === -1 && stripped.indexOf('}') === -1,
        file + ' argument 里不能有花括号(除 {{{参数}}} 占位符外;Shadowrocket 用 k=v&k=v,不是 JSON)');
      ok(arg.indexOf(',') === -1 || false,
        file + ' argument 里不能有逗号(会切碎属性行)');
      const pairs = arg.split('&').filter(Boolean);
      for (const pr of pairs) ok(pr.indexOf('=') > 0, file + ' argument 项不是 k=v 形式: ' + pr);
    }
    ok(/requires-body=1|requires-body=true/.test(s), file + ' 缺 requires-body=1(拿不到响应体)');
  }
  ok(mitmSeen, file + ' 缺 [MITM] 段');
  ok(ruleSeen >= 1, file + ' 没有 http-response 规则');
}

/* ---------------- 4. 脚本 harness ---------------- */
const GOOGLE_OK = JSON.stringify([[['你好', 'Hello', null, null, 10]], null, 'en']);
const AI_OK = JSON.stringify({ choices: [{ message: { content: '你好' } }] });
const MSG_BODY = JSON.stringify([{ id: '1', content: 'Hello world', type: 0 }]);
const URL_MESSAGES = 'https://discord.com/api/v9/channels/123456789/messages?limit=25';

function run(code, opt) {
  opt = opt || {};
  const url = opt.url || URL_MESSAGES;
  const body = opt.body === undefined ? MSG_BODY : opt.body;
  const calls = { http: [], done: [], logs: [] };
  const store = {};
  const sandbox = {
    console: { log: function () { calls.logs.push([].slice.call(arguments)); } },
    $argument: opt.argument,
    $request: { url: url, headers: {}, method: 'GET' },
    $response: opt.noResponse ? undefined : { status: opt.status === undefined ? 200 : opt.status, headers: {}, body: body },
    $done: function (a) { calls.done.push(a); },
    $notification: { post: function () { } },
    $persistentStore: {
      read: function (k) { return k === undefined ? null : (store[k] !== undefined ? store[k] : null); },
      write: function (v, k) { store[k] = v; return true; },
      remove: function (k) { delete store[k]; return true; },
    },
    $httpClient: {
      get: function (opts, cb) { calls.http.push(opts); opt.httpFail ? cb('fail', null, null) : cb(null, { status: 200 }, GOOGLE_OK); },
      post: function (opts, cb) { calls.http.push(opts); opt.httpFail ? cb('fail', null, null) : cb(null, { status: 200 }, AI_OK); },
    },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  try { vm.runInContext('(function(){' + code + '\n})()', ctx, { filename: 'harness' }); }
  catch (e) { calls.threw = String((e && e.message) || e); }
  return calls;
}

function payloadOf(c) { return c.done.length === 1 ? (c.done[0] || null) : null; }
function translated(c) {
  const d = payloadOf(c);
  if (!d || !d.body) return false;
  let arr; try { arr = JSON.parse(d.body); } catch (e) { return false; }
  return Array.isArray(arr) && arr.some(function (m) { return String(m.content).indexOf('你好') !== -1; });
}

const SR = fs.readFileSync(path.join(ROOT, 'Shadowrocket/translate-response.sr.js'), 'utf8');
const SR_ARG_STR = JSON.stringify({ enabled: true, target_lang: 'zh-CN', cache_on: false, maxcalls: 16, first_batch: 8 });
const ORDER = ['enabled', 'probe', 'debug', 'target_lang', 'engine', 'provider', 'api_key', 'model',
  'custom_base_url', 'cache_on', 'maxmsgs', 'maxcalls', 'first_batch', 'bilingual', 'custom_prompt', 'concurrency',
  'manual_ids', 'block_server'];

// A. Shadowrocket: JSON 字符串参数
{
  const c = run(SR, { argument: SR_ARG_STR });
  ok(!c.threw, 'SR 字符串参数: 抛异常 ' + c.threw);
  eq(c.done.length, 1, 'SR 字符串参数: $done 次数');
  ok(translated(c), 'SR 字符串参数: 未产生译文');
  ok(c.http.length > 0, 'SR 字符串参数: 没有发出翻译请求');
}
// B. Loon: 具名对象参数
{
  const c = run(SR, { argument: { enabled: true, target_lang: 'zh-CN', cache_on: false, maxcalls: 16, first_batch: 8 } });
  ok(translated(c), 'Loon 对象参数: 未产生译文');
}
// C. 位置数组参数
{
  const arr = new Array(ORDER.length); arr[0] = true; arr[3] = 'zh-CN'; arr[9] = false; arr[11] = 16; arr[12] = 8;
  const c = run(SR, { argument: arr });
  ok(translated(c), '位置数组参数: 未产生译文');
}
// D. 参数缺失 -> 默认值
{
  const c = run(SR, { argument: undefined });
  ok(translated(c), '参数缺失: 未按默认值翻译');
}
// E. enabled=false
{
  const c = run(SR, { argument: JSON.stringify({ enabled: false, target_lang: 'zh-CN' }) });
  eq(c.done.length, 1, 'enabled=false: $done 次数');
  ok(!(payloadOf(c) && payloadOf(c).body), 'enabled=false: 仍然改写了 body');
  eq(c.http.length, 0, 'enabled=false: 网络调用次数');
}
// E2. 位置数组 + enabled=false
{
  const arr = new Array(ORDER.length); arr[0] = false;
  const c = run(SR, { argument: arr });
  ok(!(payloadOf(c) && payloadOf(c).body), '位置数组 enabled=false: 仍在改写 body');
  eq(c.http.length, 0, '位置数组 enabled=false: 网络调用次数');
}
// F. 非 JSON body
{
  const c = run(SR, { argument: SR_ARG_STR, body: '<html>not json</html>' });
  ok(!c.threw, '非 JSON body: 抛异常 ' + c.threw);
  eq(c.done.length, 1, '非 JSON body: $done 次数');
  ok(!(payloadOf(c) && payloadOf(c).body), '非 JSON body: 不应改写 body');
}
// G. Uint8Array body(utf8)
{
  const c = run(SR, { argument: SR_ARG_STR, body: new Uint8Array(Buffer.from(MSG_BODY, 'utf8')) });
  ok(translated(c), 'Uint8Array body: 未产生译文');
}
// H. $response 缺失
{
  const c = run(SR, { argument: SR_ARG_STR, noResponse: true, body: null });
  eq(c.done.length, 1, '$response 缺失: $done 次数');
}
// I. 网络全失败
{
  const c = run(SR, { argument: SR_ARG_STR, httpFail: true });
  eq(c.done.length, 1, '网络失败: $done 次数');
  {
    const d = payloadOf(c);
    ok(!d.body || d.body === MSG_BODY, '网络失败: 写回的 body 与原文不一致(丢失数据)');
  }
}
// J. 非 Discord URL
{
  const c = run(SR, { argument: SR_ARG_STR, url: 'https://discord.com/api/v9/users/@me' });
  eq(c.done.length, 1, '非目标 URL: $done 次数');
  eq(c.http.length, 0, '非目标 URL: 网络调用次数');
}
/* ---------------- 4b. Shadowrocket 文档格式: argument=k=v&k=v ---------------- */
{
  const KV = 'enabled=true&target_lang=zh-CN&cache_on=false&maxcalls=16&first_batch=8';
  const c = run(SR, { argument: KV });
  ok(!c.threw, 'k=v 参数: 抛异常 ' + c.threw);
  eq(c.done.length, 1, 'k=v 参数: $done 次数');
  ok(translated(c), 'k=v 参数: 未产生译文');
  ok(c.http.length > 0, 'k=v 参数: 没有发出翻译请求');
  // 数字/布尔要真的被转成基本类型, 不能让 "16" 这种字符串混进去
  const c2 = run(SR, { argument: 'enabled=true&target_lang=zh-CN&cache_on=false&maxcalls=1&first_batch=1' });
  ok(c2.http.length >= 1 && c2.http.length <= 2, 'k=v 参数: maxcalls=1 没被当成数字(实际调用 ' + c2.http.length + ')');
}
{
  const c = run(SR, { argument: 'enabled=false&target_lang=zh-CN' });
  ok(!(payloadOf(c) && payloadOf(c).body), 'k=v enabled=false: 仍然改写 body');
  eq(c.http.length, 0, 'k=v enabled=false: 网络调用次数');
}

/* ---------------- 5. 负对照:旧脚本吃不下 SR 参数 ---------------- */
{
  let old = null;
  const fx = path.join(ROOT, 'tools/fixtures/translate-response.prepatch.js');
  if (fs.existsSync(fx)) old = fs.readFileSync(fx, 'utf8');
  else { try { old = cp.execSync('git show HEAD:loon/translate-response.js', { cwd: ROOT, encoding: 'utf8' }); } catch (e) { } }
  const DIS = JSON.stringify({ enabled: false, target_lang: 'zh-CN' });
  if (old && old.indexOf('__ARG') === -1) {
    // 旧脚本读不懂 JSON 字符串 -> 参数被忽略 -> enabled=false 形同虚设, 照翻
    const c = run(old, { argument: DIS });
    eq(c.done.length, 1, '负对照: 旧脚本 $done 次数');
    ok(translated(c), '负对照失效: 旧脚本本应忽略 JSON 字符串参数, 却像是读懂了');
    ok(c.http.length > 0, '负对照失效: 旧脚本本应照常发翻译请求');
  } else {
    console.log('   (跳过负对照: git HEAD 已是打过补丁的版本)');
  }
  // 打过补丁的版本必须拦住 enabled=false
  {
    const c = run(SR, { argument: DIS });
    ok(!translated(c), 'enabled=false (JSON 字符串): 仍然翻译了');
    eq(c.http.length, 0, 'enabled=false (JSON 字符串): 网络调用次数');
  }
}

/* ---------------- 6. fake-nitro-display harness ---------------- */
{
  const FN = fs.readFileSync(path.join(ROOT, 'Shadowrocket/fake-nitro-display.sr.js'), 'utf8');
  const ME = '891196284998930522';
  const PROFILE_URL = 'https://discord.com/api/v9/users/' + ME + '/profile';
  const PROFILE_BODY = JSON.stringify({ user: { id: ME, username: 'me' }, premium_type: 0, badges: [] });

  const c1 = run(FN, { argument: JSON.stringify({ enabled: true, feature: 'display', user_id: ME }), url: PROFILE_URL, body: PROFILE_BODY });
  eq(c1.done.length, 1, 'FN/SR: $done 次数');
  ok(!!(payloadOf(c1) && payloadOf(c1).body), 'FN/SR: 未注入');
  if (payloadOf(c1) && payloadOf(c1).body) {
    const d = JSON.parse(payloadOf(c1).body);
    eq(d.premium_type, 2, 'FN/SR: premium_type');
    ok(d.badges && d.badges.some(function (b) { return b.id === 'nitro'; }), 'FN/SR: 缺 NITRO 徽章');
  }
  const c2 = run(FN, { argument: JSON.stringify({ enabled: true, user_id: ME }), url: 'https://discord.com/api/v9/users/123/profile', body: PROFILE_BODY });
  ok(!(payloadOf(c2) && payloadOf(c2).body), 'FN/SR: 对别人的资料页也注入了');
  const c3 = run(FN, { argument: [true, 'display', ME], url: PROFILE_URL, body: PROFILE_BODY });
  ok(!!(payloadOf(c3) && payloadOf(c3).body), 'FN/位置数组: 未注入');
  const c4 = run(FN, { argument: JSON.stringify({ enabled: true, user_id: ME }), url: PROFILE_URL, body: 'not json' });
  ok(!c4.threw, 'FN: 非 JSON body 抛异常 ' + c4.threw);
  eq(c4.done.length, 1, 'FN: 非 JSON body $done 次数');
  ok(!(payloadOf(c4) && payloadOf(c4).body), 'FN: 非 JSON body 不应改写');
  const c5 = run(FN, { argument: JSON.stringify({ enabled: true, user_id: '' }), url: 'https://discord.com/api/v9/users/@me/entitlements', body: '[]' });
  ok(!!(payloadOf(c5) && payloadOf(c5).body) && JSON.parse(payloadOf(c5).body).length === 1, 'FN: entitlements 未注入');
  const c6 = run(FN, { argument: JSON.stringify({ enabled: false }), url: PROFILE_URL, body: PROFILE_BODY });
  ok(!(payloadOf(c6) && payloadOf(c6).body), 'FN: enabled=false 仍然注入');
  // Shadowrocket 文档格式
  const c7 = run(FN, { argument: 'enabled=true&feature=display&user_id=' + ME, url: PROFILE_URL, body: PROFILE_BODY });
  ok(!!(payloadOf(c7) && payloadOf(c7).body), 'FN/k=v: 未注入');
  const c8 = run(FN, { argument: 'enabled=false&user_id=' + ME, url: PROFILE_URL, body: PROFILE_BODY });
  ok(!(payloadOf(c8) && payloadOf(c8).body), 'FN/k=v enabled=false: 仍然注入');
}

/* ---------------- 6b. v1.20 回归: 双语模式 / 多段索引 / cache_off ---------------- */
// 假翻译: 回显 "TR:"+原文, 便于看清哪些段被送翻、哪些段丢了
function echoGoogle(url) {
  const m = /q=([^&]*)/.exec(url);
  const dec = m ? decodeURIComponent(m[1]) : '';
  return JSON.stringify([[['TR:' + dec, 'en', null, null, 10]], null, 'en']);
}
function runEcho(code, content, argument, opts) {
  opts = opts || {};
  const body = JSON.stringify([{ id: '1', content: content, type: 0 }]);
  const calls = { http: [], done: [], store: {} };
  const sandbox = {
    console: { log: function () { } },
    $argument: argument,
    $request: { url: 'https://discord.com/api/v9/channels/123/messages?limit=25', headers: {}, method: 'GET' },
    $response: opts.noResponse ? undefined : { status: 200, headers: {}, body: body },
    $done: function (a) { calls.done.push(a); },
    $notification: { post: function () { } },
    $persistentStore: {
      read: function (k) {
        if (opts.seed && opts.seed[k] !== undefined) return opts.seed[k];
        return k === undefined ? null : (calls.store[k] !== undefined ? calls.store[k] : null);
      },
      write: function (v, k) { calls.store[k] = v; return true; },
      remove: function (k) { delete calls.store[k]; return true; },
    },
    $httpClient: {
      get: function (o, cb) { calls.http.push(decodeURIComponent(/q=([^&]*)/.exec(o.url)[1])); cb(null, { status: 200 }, echoGoogle(o.url)); },
      post: function (o, cb) { calls.http.push(JSON.parse(o.body).messages[1].content); cb(null, { status: 200 }, AI_OK); },
    },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  try { vm.runInContext('(function(){' + code + '\n})()', ctx, { filename: 'h-echo' }); }
  catch (e) { calls.threw = String((e && e.message) || e); }
  calls.out = (function () { try { return JSON.parse(calls.done[0] && calls.done[0].body)[0].content; } catch (e) { return '<no body>'; } })();
  return calls;
}
const T_BILINGUAL = { enabled: true, target_lang: 'zh-CN', cache_on: false, engine: 'google', bilingual: true };
const T_PLAIN = { enabled: true, target_lang: 'zh-CN', cache_on: false, engine: 'google', bilingual: false };

// T1. 双语开启: 输出必须含原文 + 换行 + 译文
{
  const c = runEcho(SR, 'This is a plain english sentence', T_BILINGUAL);
  ok(!c.threw, '双语: 抛异常 ' + c.threw);
  ok(c.out.indexOf('This is a plain english sentence\nTR:') === 0, '双语: 未输出「原文+换行+译文」, 实际=<' + c.out + '>');
}
// T1b. 双语关闭: 只能有译文
{
  const c = runEcho(SR, 'This is a plain english sentence', T_PLAIN);
  eq(c.out, 'TR:This is a plain english sentence', '双语关闭: 输出不是纯译文');
}
// T2. 用户实报 bug: "@url:`...` 之后的英文原文" 必须被翻
{
  const RAW = '还是希望我们能合并 @url:`https://github.com/NousResearch/hermes-agent/pull/118355`, which would make Hermes Desktop visible in Linux "App Stores"';
  const c = runEcho(SR, RAW, T_PLAIN);
  ok(!c.threw, '@url 段: 抛异常 ' + c.threw);
  // 第二个可译段(URL 之后的英文)必须有译文, 不能是原文原样
  ok(c.out.indexOf('TR:, which would make Hermes Desktop visible in Linux') !== -1,
    '@url 之后的原文没被翻译(索引错位), 实际=<' + c.out + '>');
  ok(c.http.length === 2, '@url 段: 可译段数应为 2, 实际 ' + c.http.length);
  ok(c.out.indexOf('@url:`https://github.com/NousResearch/hermes-agent/pull/118355`') !== -1,
    '@url: 保护段被破坏了');
}
// T2b. 多个保护段交错(URL + @提及 + 代码块)—— 4 个可译段都要翻, URL/提及/代码块零损伤
{
  const RAW = 'look at <@123456789> this https://a.io/x and ```code block``` plus this tail sentence here';
  const c = runEcho(SR, RAW, T_PLAIN);
  const trCount = (c.out.match(/TR:/g) || []).length;
  // URL 被保护后切出 4 个自由段: "look at " / " this " / " and " / " plus this tail sentence here"
  eq(trCount, 4, '多保护段: 可译段译文数量(每个可译段应有 1 个 TR:)');
  eq(c.out, 'TR:look at <@123456789> TR: this https://a.io/x TR: and ```code block``` TR: plus this tail sentence here',
    '多保护段: 拼回结果(空格/保护段必须原位)');
  // URL 与保护段绝不能进翻译请求
  ok(c.http.every(q => q.indexOf('a.io') === -1 && q.indexOf('123456789') === -1 && q.indexOf('code block') === -1),
    '多保护段: 保护内容混进了翻译请求 ' + JSON.stringify(c.http));
}
// T2d. URL 保护正则本身: v1.20 前字符类写坏, URL 一条都匹配不到
{
  const RAW = 'Read https://github.com/a/b and reply';
  const c = runEcho(SR, RAW, T_PLAIN);
  ok(c.out.indexOf('https://github.com/a/b') !== -1, 'URL 正则: URL 丢失, 实际=<' + c.out + '>');
  ok(c.http.every(q => q.indexOf('github.com') === -1), 'URL 正则: URL 被送进翻译请求 ' + JSON.stringify(c.http));
  // URL 之后的英文才是真正要翻的部分
  ok(c.out.indexOf('TR:Read ') === 0 && c.out.indexOf('TR: and reply') !== -1, 'URL 正则: URL 前后两段都要翻, 实际=<' + c.out + '>');
}
// T2c. 双语 + 保护段: 原文整体保留在首行
{
  const RAW = 'Check this https://github.com/a/b out please';
  const c = runEcho(SR, RAW, T_BILINGUAL);
  ok(c.out.indexOf('Check this https://github.com/a/b out please\n') === 0, '双语+URL: 原文行不完整, 实际=<' + c.out + '>');
}
// T3. cache_on=false 必须真的关闭缓存: 不读也不写
{
  const c = runEcho(SR, 'A fresh untranslated sentence', { enabled: true, target_lang: 'zh-CN', cache_on: false, engine: 'google' });
  ok(c.store['TranslateCache'] === undefined, 'cache_off: 仍然写了 TranslateCache');
}
// T3b. cache_on=false 不得抹掉已有缓存
{
  const SEED = { TranslateCache: JSON.stringify({ 'old msg here': '旧译文' }) };
  const c = runEcho(SR, 'A fresh untranslated sentence', { enabled: true, target_lang: 'zh-CN', cache_on: false, engine: 'google' }, { seed: SEED });
  if (c.store['TranslateCache'] !== undefined) {
    ok(c.store['TranslateCache'].indexOf('旧译文') !== -1, 'cache_off: 把已有缓存覆盖成空了');
  } else {
    ok(true, 'cache_off: 保留已有缓存(未写)');
  }
}
// T3c. cache_on=true 正常写缓存
{
  const c = runEcho(SR, 'Another brand new sentence', { enabled: true, target_lang: 'zh-CN', cache_on: true, engine: 'google' });
  ok(c.store['TranslateCache'] && c.store['TranslateCache'].indexOf('TR:Another brand new sentence') !== -1, 'cache_on: 未写缓存');
}
// T3d. 双语模式下缓存存纯译文, 不能存「原文+译文」(否则二次命中会重复原文)
{
  const c = runEcho(SR, 'Cache should hold translation only', { enabled: true, target_lang: 'zh-CN', cache_on: true, engine: 'google', bilingual: true });
  ok(c.store['TranslateCache'].indexOf('\\nTR:') === -1, '双语缓存: 存了「原文+译文」, 二次命中会重复原文');
}
// T3e. 双语 + 缓存二次命中: 不得出现三段原文
{
  const c = runEcho(SR, 'Hit cache twice please', { enabled: true, target_lang: 'zh-CN', cache_on: true, engine: 'google', bilingual: true });
  ok(c.out.indexOf('Hit cache twice please\nTR:') === 0, '双语缓存首次: 输出异常');
}

/* ---------------- 结果 ---------------- */
console.log('');
if (failures.length) {
  console.log('FAILED (' + failures.length + ' 项失败 / ' + checks + ' 项检查)');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
console.log('ALL CHECKS PASSED (' + checks + ' checks)');

// ---- 硬约束: 每次发布必须包含的完整资产清单(两平台插件+全部脚本) ----
const REQUIRED_ASSETS = [
  "fake-nitro.plugin", "fake-nitro.module",
  "Discord.Translate.plugin", "Discord.Translate.module",
];
async function verifyReleaseAssets(releaseTag) {
  const { execSync } = require("child_process");
  const out = execSync(`gh release view ${releaseTag} --json assets --jq ".assets[].name"`).toString().trim().split("\n");
  const missing = REQUIRED_ASSETS.filter(a => !out.includes(a));
  if (missing.length) {
    console.error("FAIL: missing required assets in release " + releaseTag + ": " + missing.join(", "));
    process.exit(1);
  }
  console.log("PASS: release " + releaseTag + " has all " + REQUIRED_ASSETS.length + " required assets");
}
module.exports = { verifyReleaseAssets, REQUIRED_ASSETS };
