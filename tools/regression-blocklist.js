#!/usr/bin/env node
/* regression-blocklist.js — 必挡回归:
   v1.11.0 语义: 交付必须满 limit 条(截断/占位), 除非服务端返回 < limit(真到头)。
   R1 重拉黑页(25条里23条拉黑): 恰好 1 个 $done 且交满 25 且 blocked 全部被 mask 成 [已屏蔽]
   R2 镜像流: 补页返回全拉黑 → 仍交满 25(占位兜底), 不清零不交短页
   R3 正常页混有拉黑: 保留正常消息(kept>=1)
   R4 25条页含拉黑: 必须内部补拉 >=1 次把交付填满 25
   R5 ?before= 分页页(整页全是拉黑者)且补拉回空: 交空数组(真到头)
   R6 补页后顺序: 交付数组必须严格 新->老(HAR-672: 多次 reverse 混排致新旧颠倒) */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const scripts = [
  path.join(ROOT, 'loon', 'fakenitro-catalog.js'),
  path.join(ROOT, 'Shadowrocket', 'fakenitro-catalog.sr.js'),
];
const noopGet = (o, cb) => setTimeout(() => cb(new Error('no network in test')), 5);

function runScript(src, opts) {
  let doneCalls = [];
  const rawGet = opts.httpGet || noopGet;
  const wrappedGet = function (o, cb) {
    // 服务器黑名单拉取(测试里一律回错误 → 走本地 fallback; 也不应带 _bnfb 标记)
    if (o && o.url && o.url.indexOf('_bnfb') < 0 && /\/block/.test(o.url) && !/\/messages/.test(o.url)) {
      setTimeout(() => cb(new Error('no block server in test')), 2);
      return;
    }
    rawGet(o, cb);
  };
  const sandbox = {
    console: { log: function () {} },
    $request: { url: 'https://discord.com/api/v9/channels/123/messages' + (opts.urlSuffix || '?limit=25'), headers: { Authorization: 'tok' } },
    $response: { body: JSON.stringify(opts.page) },
    $argument: { enabled: true },
    $persistentStore: {
      read: function (k) { return k === 'discord_blocked_users' ? '["111"]' : null; },
      write: function () { return true; },
    },
    $httpClient: { get: wrappedGet },
    $done: function (x) { doneCalls.push(x); },
  };
  vm.createContext(sandbox);
  let threw = null;
  try { vm.runInContext(src, sandbox, { timeout: 10000 }); } catch (e) { threw = String(e); }
  return { doneCalls: doneCalls, threw: threw };
}

function pageHeavyBlocked() {
  const a = [];
  let id = 9e15;
  for (let i = 0; i < 25; i++) {
    a.push({ id: String(id--), author: { id: i < 23 ? '111' : '222', username: i < 23 ? 'bofang8964' : 'xiaoguaishou342' }, content: 'm' + i });
  }
  return a;
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + ' ' + (detail || ''));
  if (!ok) failures++;
}

const allBlockedOlder = JSON.stringify(Array.from({ length: 25 }, function (_, i) {
  return { id: String(8.9e15 - i), author: { id: '111', username: 'bofang8964' } };
}));

for (let s = 0; s < scripts.length; s++) {
  const label = path.relative(ROOT, scripts[s]);
  const src = fs.readFileSync(scripts[s], 'utf8');

  const heavy = runScript(src, { page: pageHeavyBlocked() });
  setTimeout(function () {
    const keptMsgs = heavy.doneCalls.filter(function (c) { return c && c.body; }).map(function (c) { return JSON.parse(c.body).length; });
    const heavyBodies = heavy.doneCalls.filter(function (c) { return c && c.body; }).map(function (c) { return JSON.parse(c.body); });
    const heavyMasked = heavyBodies.length === 1 && heavyBodies[0].every(function (m) {
      return m.author.id !== '111' || m.content === '[已屏蔽]';
    });
    check('R1 ' + label, heavy.doneCalls.length === 1 && keptMsgs[0] === 25 && heavyMasked && !heavy.threw,
      'doneCalls=' + heavy.doneCalls.length + ' kept=' + JSON.stringify(keptMsgs) + ' maskedOK=' + heavyMasked + (heavy.threw ? ' threw=' + heavy.threw : ''));

    const mirror = runScript(src, { page: pageHeavyBlocked(), httpGet: function (o, cb) { setTimeout(function () { cb(null, { status: 200 }, allBlockedOlder); }, 5); } });
    setTimeout(function () {
      const mirrorKept = mirror.doneCalls.filter(function (c) { return c && c.body; }).map(function (c) { return JSON.parse(c.body).length; });
      check('R2 ' + label, mirror.doneCalls.length === 1 && mirrorKept[0] >= 1, 'kept=' + JSON.stringify(mirrorKept));

      let fetched = 0;
      const backfillPage100 = (function () { const a = []; for (let i = 0; i < 100; i++) a.push({ id: String(100000 - i), author: { id: '222', username: 'xiaoguaishou342' }, content: 'old' }); return a; })();
      runScript(src, {
        page: pageHeavyBlocked(),
        httpGet: function (o, cb) { fetched++; setTimeout(function () { cb(null, { status: 200 }, JSON.stringify(backfillPage100)); }, 5); },
      });
      setTimeout(function () {
        const r3done = [];
        const r3 = runScript(src, {
          page: [ { id: '9', author: { id: '111', username: 'bofang8964' } }, { id: '8', author: { id: '222', username: 'xiaoguaishou342' } } ],
          httpGet: function (o, cb) { fetched++; setTimeout(function () { cb(new Error('should not fetch')); }, 5); },
        });
        setTimeout(function () {
          const r3kept = r3.doneCalls.filter(function (c) { return c && c.body; }).map(function (c) { return JSON.parse(c.body).length; });
          check('R3 ' + label, r3kept.length > 0 && r3kept[0] >= 1 && !r3.threw, 'kept=' + JSON.stringify(r3kept) + (r3.threw ? ' threw=' + r3.threw : ''));
          check('R4 ' + label, fetched >= 1, 'backfillFetches=' + fetched + ' (expect >=1: 补页填满25)');

          const r5page = Array.from({ length: 25 }, function (_, i) { return { id: String(7.7e15 - i), author: { id: '111', username: 'bofang8964' } }; });
          let r5fetch = 0;
          const r5 = runScript(src, {
            urlSuffix: '?limit=25&before=880000000000000000',
            page: r5page,
            httpGet: function (o, cb) { r5fetch++; setTimeout(function () { cb(null, { status: 200 }, '[]'); }, 5); },
          });
          setTimeout(function () {
            const r5lens = r5.doneCalls.filter(function (c) { return c && c.body; }).map(function (c) { return JSON.parse(c.body).length; });
            const pass = r5.doneCalls.length === 1 && r5lens.length === 1 && r5lens[0] === 0 && r5fetch >= 1 && !r5.threw;
            check('R5 ' + label, pass,
              'doneCalls=' + r5.doneCalls.length + ' lens=' + JSON.stringify(r5lens) + ' fetch=' + r5fetch + (r5.threw ? ' threw=' + r5.threw : ''));
          }, 400);
          const r6ids = Array.from({ length: 50 }, function (_, i) { return String(85e14 - i); });
          // page = 25 raw: 前2条是拉黑者, 后23条正常 → downsize kept=23, L=25 → 需要 backfill
          const r6page = [];
          for (let i = 0; i < 25; i++) r6page.push({ id: r6ids[i], author: { id: i < 2 ? '111' : '222', username: i < 2 ? 'bofang8964' : 'xiaoguaishou342' }, content: 'm' + i });
          let r6fetch = 0;
          const r6 = runScript(src, {
            urlSuffix: '?limit=25&before=990000000000000000',
            page: r6page,
            httpGet: function (o, cb) {
              if ((o.url || '').indexOf('_bnfb') < 0) { setTimeout(function () { cb(new Error('unexpected fetch')); }, 3); return; }
              r6fetch++;
              let arr;
              if (r6fetch === 1) arr = [ { id: r6ids[25], author: { id: '333', username: 'other' }, content: 'old-1' },
                                         { id: r6ids[26], author: { id: '333', username: 'other' }, content: 'old-2' } ];
              else arr = [];
              setTimeout(function () { cb(null, { status: 200 }, JSON.stringify(arr)); }, 5);
            },
          });
          setTimeout(function () {
            const r6done = r6.doneCalls.filter(function (c) { return c && c.body; }).map(function (c) { return JSON.parse(c.body); });
            const r6order = r6done.length === 1 ? r6done[0].map(function (m) { return m.id; }) : [];
            const pass = r6.doneCalls.length === 1 && r6order.length === 25 &&
              r6order[0] === r6ids[2] && r6order[22] === r6ids[24] && r6order[23] === r6ids[25] && r6order[24] === r6ids[26] &&
              r6order.every((id, i) => i === 0 || BigInt(r6order[i-1]) > BigInt(id)) && !r6.threw;
            check('R6 ' + label, pass,
              'order=' + JSON.stringify([r6order[0], r6order[22], r6order[23], r6order[24]]) + ' fetch=' + r6fetch + (r6.threw ? ' threw=' + r6.threw : ''));
            console.log(failures === 0 ? 'BLOCKLIST REGRESSION: ALL PASS' : 'BLOCKLIST REGRESSION: ' + failures + ' FAILURE(S)');
            process.exit(failures === 0 ? 0 : 1);
          }, 400);
        }, 400);
      }, 400);
    }, 400);
  }, 400);
}
