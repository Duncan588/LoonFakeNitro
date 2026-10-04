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
      ok(arg.indexOf('{') === -1 && arg.indexOf('}') === -1,
        file + ' argument 里不能有花括号(Shadowrocket 用 k=v&k=v,不是 JSON)');
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
  'custom_base_url', 'cache_on', 'maxmsgs', 'maxcalls', 'first_batch', 'bilingual', 'custom_prompt', 'concurrency'];

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
