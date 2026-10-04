/*
 Discord FakeNitro.display v2.1.0 — 纯手机 Loon 显示层
 拦截:
  1. GET /users/{id}/profile        → premium_type=2, premium_since 注入, NITRO 徽章前插
  2. GET /users/@me/entitlements    → 注入 Nitro PREMIUM_SUBSCRIPTION entitlement
 已知边界: 表情选择器/横幅上传等服务端与 READY 判定不在此列(需 gateway 改写, 见 PC 方案)。
*/
/* ---------- 跨平台兼容层(Loon / Shadowrocket / Surge 通用) ---------- */
function parseArgString(s) {
  var o = {}, parts = String(s).split("&");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p) continue;
    var eq = p.indexOf("=");
    if (eq < 0) continue;
    var k = p.slice(0, eq), v = p.slice(eq + 1);
    try { k = decodeURIComponent(k); } catch (e) { }
    try { v = decodeURIComponent(v); } catch (e) { }
    /* 只转换布尔;数字一律保持字符串 —— 18 位雪花 ID 转 Number 会丢精度 */
    if (v === "true") v = true; else if (v === "false") v = false;
    o[k] = v;
  }
  return o;
}
var ARG_ORDER=["enabled","feature","user_id"];
var _A=(typeof $argument==="undefined")?null:$argument;
if(typeof _A==="string"){
  var _s=_A.replace(/^\s+|\s+$/g,"");
  if(_s.charAt(0)==="{"||_s.charAt(0)==="["){ try{ _A=JSON.parse(_s); }catch(e){ _A=null; } }
  else if(_s.indexOf("=")!==-1){ _A=parseArgString(_s); }
  else { _A=null; }
}
if(Array.isArray(_A)){ var _p={}; for(var _i=0;_i<ARG_ORDER.length;_i++){ _p[ARG_ORDER[_i]]=_A[_i]; } _A=_p; }
if(!_A||typeof _A!=="object") _A={};
function bodyText(b){
  if(b===null||b===undefined) return null;
  if(typeof b==="string") return b;
  try{
    if(b&&typeof b.length==="number"&&typeof b.byteLength==="number"&&typeof b.charCodeAt!=="function"){ var s=""; for(var i=0;i<b.length;i++) s+=String.fromCharCode(b[i]&0xff); try{ return decodeURIComponent(escape(s)); }catch(e2){ return s; } }
    if(b&&typeof b.byteLength==="number"&&b.length===undefined) return bodyText(new Uint8Array(b));
  }catch(e3){}
  try{ return String(b); }catch(e4){ return null; }
}
var ARGS=_A;
function CFGv(k,d){ return ARGS&&ARGS[k]!==undefined&&ARGS[k]!==null&&ARGS[k]!==""?ARGS[k]:d; }
var _EN=CFGv("enabled", true); if(_EN==="false"||_EN===0||_EN==="0") _EN=false;
var USER_ID=String(CFGv("user_id", _A.user_id||""));
var DONE=false;
function doneOnce(a){ if(DONE) return; DONE=true; try{$done(a);}catch(e){} }
function log(m){ try{ console.log("[FakeNitro] "+m); }catch(e){} }
function probeLog(m){ try{ console.log("[FakeNitro] hit " + m); }catch(e){} }
probeLog("url=" + ($request?($request.url||""):"?"));

var body=bodyText($response?$response.body:null);
var url=$request?($request.url||""):"";
var path=url.split("?")[0];
if(_EN===false||!body){ doneOnce({}); }
else if(/\/api\/v\d+\/users\/[^\/]+\/profile$/i.test(path)){
  try{
    var mId=path.match(/\/users\/([^\/]+)\/profile/i);
    var SELF=USER_ID;
    if(SELF && mId && mId[1]!==SELF){ log("skip other user "+mId[1]); doneOnce({}); }
    var d=JSON.parse(body);
    if(d && typeof d==="object"){
      d.premium_type=2;
      d.premium=true;
      if(!d.premium_since) d.premium_since="2024-01-01T00:00:00+00:00";
      d.badges=d.badges||[];
      var has=false;
      for(var i=0;i<d.badges.length;i++){ if(d.badges[i]&&d.badges[i].id==="nitro"){ has=true; break; } }
      if(!has){
        d.badges.unshift({ id:"nitro", description:"Discord Nitro", icon:"a7a36a80e2ebc06eeab8481f30b5d543", link:"https://discord.com/nitro" });
      }
      log("profile injected");
      doneOnce({ body: JSON.stringify(d) });
    } else doneOnce({});
  }catch(e){ log("profile parse fail"); doneOnce({}); }
}
else if(/\/api\/v\d+\/users\/@me\/entitlements$/i.test(path)){
  try{
    var d2=JSON.parse(body);
    if(Array.isArray(d2)){
      var ent={ id:"999999999999999990", type:2, sku_id:"521842831262875670", application_id:"521842831262875670", user_id:"0", deleted:false, starts_at:null, ends_at:null, gift_code_flags:0 };
      d2.push(ent);
      log("entitlements injected");
      doneOnce({ body: JSON.stringify(d2) });
    } else doneOnce({});
  }catch(e){ doneOnce({}); }
}
else doneOnce({});
