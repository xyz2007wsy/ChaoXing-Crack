// ==UserScript==
// @name         超星学习通 · 名著阅读刷时长助手
// @namespace    https://github.com/cx-helper/chaoxing-reading-helper
// @version      0.5.0
// @description  超星学习通《名著阅读》自动刷时长：刷书自动滚动+翻页+刷新恢复；刷视频由顶层单控制器统一播放，播放期间不滚动、不切页，完整播完只切换一次，支持 1×/1.5×/2×。
// @author       CX Helper
// @match        *://chaoxing.com/*
// @match        *://*.chaoxing.com/*
// @match        *://chaoxing.cn/*
// @match        *://*.chaoxing.cn/*
// @match        *://chaoxing.com.cn/*
// @match        *://*.chaoxing.com.cn/*
// @match        *://*.xuexitong.com/*
// @match        *://xuexitong.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

/*
 * 使用说明
 * 1. 安装 Tampermonkey（篡改猴），新建脚本，粘贴本文件全部内容并保存。
 * 2. 打开学习通《名著阅读》任务页面，右上角会出现控制面板。
 * 3. 选择「刷书」或「刷视频」，点「开始刷时长」。
 * 4. 刷书：自动缓慢滚动、到页底后等待并点击「下一页/下一章」，卡住时自动刷新并恢复进度。
 * 5. 刷视频：自动播放、静音、倍速、播完自动切下一集，切到后台也不暂停（由脚本伪装页面可见）。
 * 6. 面板可用 Alt+Shift+C 随时显示/隐藏；「—」收起为悬浮球。
 *
 * 注意：脚本仅做页面自动化，不修改平台数据，请遵守平台规则，风险自负。
 */

(function () {
  'use strict';

  /* ============================================================
   * 0. 常量与基础状态
   * ============================================================ */

  const VERSION = '0.5.0';
  const IS_TOP = (function () {
    try { return window.top === window.self; } catch (e) { return false; }
  })();

  /* v0.4：同源顶层页面能直接访问本框架时，视频统一由顶层控制，
     避免“顶层 + 中间 iframe + 播放器 iframe”同时抢同一个 video。 */
  function topDocumentAccessible() {
    if (IS_TOP) return true;
    try {
      return !!(window.top && window.top.document && window.top.document.documentElement);
    } catch (e) {
      return false;
    }
  }

  const CFG_KEY = 'cx_helper_cfg_v1';
  const RUN_KEY = 'cx_helper_run_v1';
  const UI_KEY = 'cx_helper_ui_v1';

  const HAS_GM = (typeof GM_getValue === 'function' && typeof GM_setValue === 'function');

  const DEFAULTS = {
    mode: 'book',
    speed: 'medium',
    step: 25,
    interval: 100,
    waitMin: 3,
    waitMax: 5,
    autoNext: true,
    autoReload: true,
    rate: 1,
    muted: true,
    autoNextVideo: true,
    antiPause: true,
    spoofVisible: true,
    autoResume: true,
    showLog: true,
    nextSel: {}
  };

  const SPEED_PRESETS = {
    slow: { step: 12, interval: 160 },
    medium: { step: 25, interval: 100 },
    fast: { step: 60, interval: 40 }
  };

  const MAX_RELOADS = 30;
  const LOG_MAX = 120;

  /* ============================================================
   * 1. 存储（GM 优先，localStorage 兜底）
   * ============================================================ */

  function gmGet(key, def) {
    try {
      if (HAS_GM) {
        const v = GM_getValue(key);
        return (v === undefined || v === null) ? def : v;
      }
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : def;
    } catch (e) {
      return def;
    }
  }

  function gmSet(key, val) {
    try {
      if (HAS_GM) {
        GM_setValue(key, val);
      } else {
        window.localStorage.setItem(key, JSON.stringify(val));
      }
    } catch (e) {
      /* 忽略写入失败 */
    }
  }

  const cfg = Object.assign({}, DEFAULTS, gmGet(CFG_KEY, {}));
  if (cfg.mode !== 'book' && cfg.mode !== 'video') cfg.mode = 'book';

  /* v0.3 安全迁移：默认 1 倍速。旧版本的默认 2× 会让平台播放器产生额外的
     ratechange/进度跳变，遇到风控时可先用 1× 排除倍速因素；用户仍可在面板改回。 */
  if (!cfg.rateSafeV3) {
    if (Number(cfg.rate) > 1) cfg.rate = 1;
    cfg.rateSafeV3 = true;
    gmSet(CFG_KEY, cfg);
  }

  /* v0.5：播放倍速只保留 1× / 1.5× / 2×。旧配置里的 3×、4×、8×
     会被平台判定为异常进度，迁移时统一压到 2× 以内。 */
  if (!cfg.rateSafeV5) {
    const r = Number(cfg.rate) || 1;
    cfg.rate = r >= 1.99 ? 2 : (r >= 1.25 ? 1.5 : 1);
    cfg.rateSafeV5 = true;
    gmSet(CFG_KEY, cfg);
  }

  let run = Object.assign({
    running: false,
    mode: cfg.mode,
    startedAt: 0,
    reloads: 0,
    progress: 0,
    beat: 0,
    url: ''
  }, gmGet(RUN_KEY, {}));

  const state = {
    running: false,
    mode: cfg.mode,
    startedAt: 0,
    elapsed: 0,
    reloads: 0,
    completed: false,
    statusText: '未启动',
    level: 'idle'
  };

  /* ============================================================
   * 2. 日志与状态
   * ============================================================ */

  const logBuf = [];
  let ui = null;
  let lastStatusPost = 0;
  let lastLogPost = 0;
  /* 跨域播放器由子框架控制时，用它记录最近一次子框架状态，避免顶层覆盖。 */
  let lastChildStatusAt = 0;
  /* 同源子框架被顶层接管时置 true：它仍然 running，但不能再向顶层转发状态。 */
  let videoDeferred = false;
  /* 只有真正启动了自己的 VideoEngine 的跨域子框架，才允许向顶层转发状态/日志。 */
  let relayEnabled = false;

  function relayToTop(payload) {
    if (IS_TOP || !relayEnabled || !state.running) return;
    try {
      if (window.top && window.top !== window) window.top.postMessage(payload, '*');
    } catch (e) { /* ignore */ }
  }

  function log(msg, level) {
    level = level || 'info';
    const item = { t: Date.now(), msg: String(msg), level: level };
    logBuf.push(item);
    if (logBuf.length > LOG_MAX) logBuf.shift();
    try {
      console.log('%c[超星助手]', 'color:#7c5cff;font-weight:600', msg);
    } catch (e) { /* ignore */ }
    if (ui && ui.pushLog) {
      try { ui.pushLog(item); } catch (e) { /* ignore */ }
    }
    const now = Date.now();
    if (!IS_TOP && state.running && state.mode === 'video' && now - lastLogPost > 500) {
      lastLogPost = now;
      relayToTop({ __cx_helper: 'log', msg: item.msg, level: level });
    }
  }

  function setStatus(text, level) {
    level = level || 'info';
    if (state.statusText === text && state.level === level) return;
    state.statusText = text;
    state.level = level;
    if (ui && ui.tick) {
      try { ui.tick(); } catch (e) { /* ignore */ }
    }
    const now = Date.now();
    if (!IS_TOP && state.running && state.mode === 'video' && now - lastStatusPost > 700) {
      lastStatusPost = now;
      relayToTop({ __cx_helper: 'status', text: text, level: level });
    }
  }

  /* ============================================================
   * 3. 工具函数
   * ============================================================ */

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function fmtClock(ms) {
    if (!ms || ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '--:--';
    const total = Math.floor(sec);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return pad2(m) + ':' + pad2(s);
  }

  function rnd(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    if (max < min) max = min;
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  /* v0.5：只允许 1× / 1.5× / 2×，避免高倍速触发平台进度异常。 */
  function normalizeRate(v) {
    v = Number(v) || 1;
    if (v >= 1.99) return 2;
    if (v >= 1.25) return 1.5;
    return 1;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity || '1') === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    } catch (e) {
      return false;
    }
  }

  function isClickable(el) {
    if (!el || !el.isConnected || !isVisible(el)) return false;
    try {
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const cs = win.getComputedStyle(el);
      if (cs.pointerEvents === 'none') return false;
      if (el.disabled) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      const cls = (el.getAttribute('class') || '') + ' ' + (el.id || '');
      if (/(disabled|is-disabled|forbid|unable)/i.test(cls)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function labelOf(el) {
    if (!el) return '';
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 24 ? t.slice(0, 24) + '…' : t;
  }

  function cleanLabel(s) {
    return String(s || '')
      .replace(/[\uE000-\uF8FF\uFFFD\u200B-\u200F]/g, '')
      .replace(/[\s\u00A0]+/g, '');
  }

  function labelMatchesWords(el, words) {
    if (!el || el.nodeType !== 1) return false;
    let text = '';
    let aria = '';
    try { text = cleanLabel((el.value || '') + ' ' + (el.innerText || el.textContent || '')); } catch (e) { text = ''; }
    try {
      aria = cleanLabel((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || ''));
    } catch (e) { aria = ''; }
    const bad = /(上一页|上一頁|上一章|上一节|上一節|prev|previous)/i;
    if (text && text.length <= 24 && !bad.test(text)) {
      for (let i = 0; i < words.length; i++) {
        if (text.indexOf(words[i]) === 0) return true;
      }
    }
    if (aria && aria.length <= 24 && !bad.test(aria)) {
      for (let i = 0; i < words.length; i++) {
        if (aria.indexOf(words[i]) === 0) return true;
      }
    }
    return false;
  }

  function findClickableByWords(words, badRe, doc, limit) {
    doc = doc || document;
    badRe = badRe || /(?!)/;
    limit = limit || 30;
    const out = [];
    let nodes;
    try {
      nodes = doc.querySelectorAll('a,button,[role="button"],li,span,div,strong,em,i,input[type="button"],input[type="submit"]');
    } catch (e) {
      return out;
    }
    const max = Math.min(nodes.length, 6000);
    for (let i = 0; i < max; i++) {
      const el = nodes[i];
      if (!labelMatchesWords(el, words)) continue;
      if (!isClickable(el)) continue;
      if (inBadContainer(el, badRe)) continue;
      out.push(el);
      if (out.length >= limit) break;
    }
    out.sort(function (a, b) {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    });
    return out;
  }

  function inBadContainer(el, badRe) {
    let p = el;
    for (let i = 0; i < 6 && p; i++) {
      const cls = (p.getAttribute && p.getAttribute('class')) || '';
      const id = (p.getAttribute && p.id) || '';
      if (badRe.test(cls + ' ' + id)) return true;
      p = p.parentElement;
    }
    return false;
  }

  function findClickableAll(re, out, badRe, limit, doc) {
    badRe = badRe || /(?!)/;
    limit = limit || 30;
    doc = doc || document;
    let nodes;
    try {
      nodes = doc.querySelectorAll('a,button,[role="button"],li,span,div,strong,em,input[type="button"],input[type="submit"]');
    } catch (e) {
      return out;
    }
    const max = Math.min(nodes.length, 6000);
    for (let i = 0; i < max; i++) {
      const el = nodes[i];
      if (el.id === 'cx-helper-host') continue;
      const t = ((el.value || '') + ' ' + (el.textContent || '')).replace(/\s+/g, ' ').trim();
      if (!t || t.length > 20 || !re.test(t)) continue;
      if (!isClickable(el)) continue;
      if (inBadContainer(el, badRe)) continue;
      out.push(el);
      if (out.length >= limit) break;
    }
    return out;
  }

  function findClickableByText(re, badRe, doc) {
    const hits = findClickableAll(re, [], badRe, 30, doc);
    if (!hits.length) return null;
    hits.sort(function (a, b) {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    });
    return hits[0];
  }

  function clickEl(el, opts) {
    if (!el) return false;
    if (!opts || !opts.noScroll) {
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
    }
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { r = { left: 0, top: 0, width: 0, height: 0 }; }
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1
    };
    const PE = win.PointerEvent || win.MouseEvent;
    function fire(type, Ctor) {
      let ev;
      try { ev = new Ctor(type, base); } catch (e) { return; }
      try { el.dispatchEvent(ev); } catch (e) { /* ignore */ }
    }
    fire('pointerover', PE);
    fire('pointerenter', PE);
    fire('pointerdown', PE);
    fire('mousedown', win.MouseEvent || PE);
    fire('pointerup', PE);
    fire('mouseup', win.MouseEvent || PE);
    fire('click', win.MouseEvent || PE);
    return true;
  }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  /* ============================================================
   * 4. 定时器调度器（Web Worker，避免后台标签页定时器被降频）
   * ============================================================ */

  const Scheduler = (function () {
    let worker = null;
    let workerFailed = false;
    let workerReady = false;
    let seq = 0;
    const handlers = new Map();

    function ensureWorker() {
      if (worker) return true;
      if (workerFailed) return false;
      try {
        const code =
          'var ts={};' +
          'onmessage=function(e){var d=e.data||{};var id=d.id;' +
          'if(d.cmd==="ping"){postMessage({pong:1});return;}' +
          'if(d.cmd==="set"){' +
          'if(d.once){ts[id]=setTimeout(function(){delete ts[id];postMessage({id:id});},d.ms);}' +
          'else{ts[id]=setInterval(function(){postMessage({id:id});},d.ms);}' +
          '}else if(d.cmd==="clear"){clearTimeout(ts[id]);clearInterval(ts[id]);delete ts[id];}' +
          '};';
        const blob = new Blob([code], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        worker = new Worker(url);
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        worker.onerror = function () {
          workerReady = false;
          workerFailed = true;
          try { worker.terminate(); } catch (err) { /* ignore */ }
          worker = null;
        };
        worker.onmessage = function (ev) {
          if (ev && ev.data && ev.data.pong) {
            workerReady = true;
            return;
          }
          const id = ev.data && ev.data.id;
          const fn = handlers.get(id);
          if (fn) {
            try { fn(); } catch (err) { console.error(err); }
          }
        };
        try { worker.postMessage({ cmd: 'ping' }); } catch (e) { /* ignore */ }
        return true;
      } catch (e) {
        workerFailed = true;
        worker = null;
        return false;
      }
    }

    function set(ms, fn, once) {
      ms = Math.max(0, Math.floor(ms) || 0);
      if (ensureWorker() && worker && workerReady) {
        const id = 'w' + (++seq);
        handlers.set(id, once
          ? function () { handlers.delete(id); fn(); }
          : fn);
        try {
          worker.postMessage({ cmd: 'set', id: id, ms: ms, once: !!once });
          return {
            clear: function () {
              handlers.delete(id);
              try { worker.postMessage({ cmd: 'clear', id: id }); } catch (e) { /* ignore */ }
            }
          };
        } catch (e) {
          handlers.delete(id);
          workerFailed = true;
          workerReady = false;
          worker = null;
        }
      }
      const id = 't' + (++seq);
      handlers.set(id, fn);
      const timer = once
        ? window.setTimeout(function () { handlers.delete(id); fn(); }, ms)
        : window.setInterval(function () {
            try { fn(); } catch (err) { console.error(err); }
          }, ms);
      return {
        clear: function () {
          handlers.delete(id);
          window.clearTimeout(timer);
          window.clearInterval(timer);
        }
      };
    }

    return {
      every: function (ms, fn) { return set(ms, fn, false); },
      after: function (ms, fn) { return set(ms, fn, true); },
      sleep: function (ms) {
        return new Promise(function (resolve) { set(ms, resolve, true); });
      }
    };
  })();

  function sleep(ms) {
    return Scheduler.sleep(ms);
  }

  /* ============================================================
   * 5. 反后台限制：伪装页面可见 / 始终有焦点
   * ============================================================ */

  let visibilitySpoofed = false;

  function installVisibilitySpoof() {
    if (visibilitySpoofed || !cfg.spoofVisible) return;
    visibilitySpoofed = true;

    const fake = {
      hidden: false,
      visibilityState: 'visible',
      webkitHidden: false,
      webkitVisibilityState: 'visible'
    };

    Object.keys(fake).forEach(function (key) {
      try {
        Object.defineProperty(Document.prototype, key, {
          configurable: true,
          get: function () { return fake[key]; }
        });
      } catch (e) { /* ignore */ }
    });

    try {
      Object.defineProperty(document, 'hasFocus', {
        configurable: true,
        value: function () { return true; }
      });
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
   * 6. SPA 路由监听（学习通大量页面为单页切换）
   * ============================================================ */

  let spaTimer = null;

  function hookSpa() {
    try {
      ['pushState', 'replaceState'].forEach(function (name) {
        const orig = history[name];
        if (typeof orig !== 'function') return;
        history[name] = function () {
          const ret = orig.apply(this, arguments);
          window.setTimeout(function () {
            window.dispatchEvent(new Event('cx:locationchange'));
          }, 0);
          return ret;
        };
      });
    } catch (e) { /* ignore */ }

    window.addEventListener('popstate', function () {
      window.dispatchEvent(new Event('cx:locationchange'));
    });

    window.addEventListener('cx:locationchange', function () {
      if (spaTimer) window.clearTimeout(spaTimer);
      spaTimer = window.setTimeout(function () {
        if (!state.running) return;
        log('检测到页面切换，重新定位…');
        if (state.mode === 'book') BookEngine.reposition();
        else if (state.mode === 'video') VideoEngine.rescan();
      }, 900);
    });
  }

  /* ============================================================
   * 7. 控制面板（Shadow DOM，避免与学习通样式互相污染）
   * ============================================================ */

  const PANEL_HTML = [
    '<style>',
    ':host{all:initial;}',
    '*{box-sizing:border-box;}',
    '[hidden]{display:none !important;}',
    '.wrap{position:fixed;inset:0;pointer-events:none;z-index:2147483647;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}',
    '.panel{position:absolute;top:16px;right:16px;width:336px;max-height:calc(100vh - 32px);',
    'display:flex;flex-direction:column;pointer-events:auto;color:#e9e9f2;',
    'background:linear-gradient(180deg,rgba(26,26,36,.97),rgba(15,15,22,.98));',
    'border:1px solid rgba(255,255,255,.09);border-radius:16px;',
    'box-shadow:0 18px 50px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06);',
    'backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);overflow:hidden;}',
    '.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;user-select:none;',
    'background:linear-gradient(90deg,rgba(124,92,255,.20),rgba(62,198,255,.04) 60%,transparent);',
    'border-bottom:1px solid rgba(255,255,255,.07);}',
    '.logo{width:24px;height:24px;border-radius:8px;flex:0 0 auto;display:grid;place-items:center;',
    'font-size:12px;font-weight:700;color:#fff;background:linear-gradient(135deg,#7c5cff,#3ec6ff);',
    'box-shadow:0 4px 12px rgba(124,92,255,.45);}',
    '.title{font-size:13px;font-weight:600;letter-spacing:.2px;white-space:nowrap;}',
    '.ver{font-size:10px;color:#8b8ba3;margin-left:5px;font-weight:400;}',
    '.hd-btns{margin-left:auto;display:flex;gap:5px;}',
    '.hd-btns button{width:22px;height:22px;padding:0;border:0;border-radius:7px;cursor:pointer;',
    'background:rgba(255,255,255,.07);color:#c9c9dd;font-size:14px;line-height:1;}',
    '.hd-btns button:hover{background:rgba(255,255,255,.14);color:#fff;}',
    '.body{flex:1 1 auto;min-height:0;padding:11px 12px 10px;overflow-y:auto;overflow-x:hidden;}',
    '.body::-webkit-scrollbar{width:6px;}',
    '.body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px;}',
    '.seg{display:flex;gap:3px;padding:3px;border-radius:10px;background:rgba(255,255,255,.05);}',
    '.seg button{flex:1;padding:7px 0;border:0;border-radius:8px;background:transparent;',
    'color:#9a9ab0;font-size:12px;cursor:pointer;transition:.15s;}',
    '.seg button:hover:not(:disabled){color:#d8d8ea;}',
    '.seg button.on{color:#fff;background:linear-gradient(135deg,#7c5cff,#5b8cff);',
    'box-shadow:0 4px 12px rgba(124,92,255,.38);}',
    '.seg button:disabled{opacity:.32;cursor:not-allowed;}',
    '.status{display:flex;align-items:center;gap:7px;margin:10px 0;padding:8px 10px;',
    'border-radius:10px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.055);',
    'font-size:12px;color:#b9b9cc;min-height:34px;}',
    '.dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:#5d5d75;}',
    '.dot.run{background:#3ddc84;animation:pulse 1.6s infinite;}',
    '.dot.wait{background:#f5c542;animation:pulse 1.6s infinite;}',
    '.dot.warn{background:#f5a524;}',
    '.dot.err{background:#ff5d5d;}',
    '.dot.ok{background:#3ddc84;}',
    '@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(61,220,132,.5);}70%{box-shadow:0 0 0 6px rgba(61,220,132,0);}100%{box-shadow:0 0 0 0 rgba(61,220,132,0);}}',
    '.status-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.spacer{flex:1;}',
    '.elapsed{font:11px ui-monospace,Consolas,monospace;color:#8f8fa8;flex:0 0 auto;}',
    '.primary{width:100%;padding:11px 0;border:0;border-radius:11px;cursor:pointer;',
    'font-size:14px;font-weight:600;color:#fff;letter-spacing:.5px;',
    'background:linear-gradient(135deg,#22c55e,#16a34a);',
    'box-shadow:0 8px 20px rgba(34,197,94,.28);transition:.18s;}',
    '.primary:hover{filter:brightness(1.06);}',
    '.primary.stop{background:linear-gradient(135deg,#ef4444,#dc2626);box-shadow:0 8px 20px rgba(239,68,68,.26);}',
    '.tabs{display:flex;gap:2px;margin:12px 0 8px;border-bottom:1px solid rgba(255,255,255,.07);}',
    '.tabs button{padding:7px 9px;border:0;border-bottom:2px solid transparent;background:transparent;',
    'color:#8f8fa6;font-size:12px;cursor:pointer;}',
    '.tabs button.on{color:#cfc6ff;border-bottom-color:#7c5cff;}',
    '.pane{padding-top:2px;}',
    '.field{margin:9px 0 11px;}',
    '.field>label{display:flex;justify-content:space-between;align-items:baseline;',
    'font-size:11.5px;color:#9f9fb8;margin-bottom:6px;}',
    '.field label b{color:#cfc6ff;font-weight:600;}',
    'input[type=range]{-webkit-appearance:none;appearance:none;display:block;width:100%;height:4px;',
    'border-radius:2px;background:rgba(255,255,255,.13);outline:none;cursor:pointer;}',
    'input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;',
    'border-radius:50%;background:#fff;border:3px solid #7c5cff;',
    'box-shadow:0 0 0 3px rgba(124,92,255,.18);cursor:pointer;}',
    'input[type=range]::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#fff;',
    'border:3px solid #7c5cff;cursor:pointer;}',
    '.mini-seg{display:flex;gap:4px;margin-top:7px;flex-wrap:wrap;}',
    '.mini-seg button{flex:1;min-width:40px;padding:5px 2px;border:1px solid rgba(255,255,255,.09);',
    'border-radius:7px;background:rgba(255,255,255,.03);color:#9a9ab0;font-size:11px;cursor:pointer;}',
    '.mini-seg button:hover{color:#d8d8ea;}',
    '.mini-seg button.on{background:rgba(124,92,255,.22);border-color:rgba(124,92,255,.55);color:#ddd6ff;}',
    '.check{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12px;color:#c2c2d6;cursor:pointer;}',
    '.check input{width:14px;height:14px;margin:0;accent-color:#7c5cff;cursor:pointer;}',
    '.log{margin-top:8px;height:120px;overflow-y:auto;padding:7px 9px;border-radius:9px;',
    'background:rgba(0,0,0,.30);border:1px solid rgba(255,255,255,.05);',
    'font:11px/1.55 ui-monospace,Consolas,monospace;color:#9fe6b8;}',
    '.log-line{white-space:pre-wrap;word-break:break-all;}',
    '.log-line.warn{color:#ffd166;}',
    '.log-line.err{color:#ff8a8a;}',
    '.log-line.ok{color:#6ee7b7;}',
    '.tip{margin-top:9px;font-size:10.5px;line-height:1.6;color:#7f7f96;}',
    '.calib{display:flex;gap:6px;margin-top:2px;}',
    '.linkbtn{flex:1;padding:7px 6px;border:1px dashed rgba(124,92,255,.5);border-radius:8px;',
    'background:rgba(124,92,255,.10);color:#cfc6ff;font-size:11px;cursor:pointer;}',
    '.linkbtn:hover{background:rgba(124,92,255,.20);}',
    '.linkbtn:disabled{opacity:.45;cursor:not-allowed;}',
    '.hint{margin-top:6px;font-size:10.5px;line-height:1.55;color:#7f7f96;}',
    '.ft{padding:8px 12px;border-top:1px solid rgba(255,255,255,.06);font-size:10px;',
    'color:#6f6f86;text-align:center;letter-spacing:.2px;}',
    '.ball{position:absolute;right:20px;bottom:90px;width:48px;height:48px;border-radius:50%;',
    'display:grid;place-items:center;pointer-events:auto;cursor:pointer;color:#fff;',
    'background:linear-gradient(135deg,#7c5cff,#3ec6ff);',
    'box-shadow:0 10px 26px rgba(124,92,255,.5);user-select:none;}',
    '.ball .ring{position:absolute;inset:-5px;border-radius:50%;border:2px solid rgba(124,92,255,.55);',
    'opacity:0;}',
    '.ball.running .ring{opacity:1;animation:halo 1.8s infinite;}',
    '@keyframes halo{0%{transform:scale(.92);opacity:.8;}70%{transform:scale(1.18);opacity:0;}100%{opacity:0;}}',
    '.ball-ico{font-size:15px;font-weight:700;}',
    '</style>',
    '<div class="wrap">',
    '  <div class="panel" id="panel">',
    '    <div class="hd" id="hd">',
    '      <div class="logo">阅</div>',
    '      <div class="title">名著阅读助手<span class="ver">v0.5.0</span></div>',
    '      <div class="hd-btns">',
    '        <button id="btnMin" title="收起为悬浮球">—</button>',
    '        <button id="btnHide" title="隐藏面板（Alt+Shift+C 重新打开）">×</button>',
    '      </div>',
    '    </div>',
    '    <div class="body">',
    '      <div class="seg" id="modeSeg">',
    '        <button data-mode="book">刷书</button>',
    '        <button data-mode="video">刷视频</button>',
    '        <button data-mode="homework" disabled title="框架预留，暂未实现">作业</button>',
    '      </div>',
    '      <div class="status">',
    '        <span class="dot" id="dot"></span>',
    '        <span class="status-text" id="statusText">未启动</span>',
    '        <span class="spacer"></span>',
    '        <span class="elapsed" id="elapsed">00:00:00</span>',
    '      </div>',
    '      <button class="primary" id="btnRun">开始刷时长</button>',
    '      <div class="tabs" id="tabs">',
    '        <button data-tab="book">刷书</button>',
    '        <button data-tab="video">刷视频</button>',
    '        <button data-tab="misc">高级</button>',
    '      </div>',
    '      <div class="pane" data-pane="book">',
    '        <div class="field">',
    '          <label>阅读速度</label>',
    '          <div class="mini-seg" id="speedSeg">',
    '            <button data-speed="slow">慢</button>',
    '            <button data-speed="medium">中</button>',
    '            <button data-speed="fast">快</button>',
    '            <button data-speed="custom">自定义</button>',
    '          </div>',
    '        </div>',
    '        <div class="field" id="customSpeed" hidden>',
    '          <label>滚动步长 <b id="stepVal">25</b> px</label>',
    '          <input type="range" id="stepRange" min="5" max="300" step="5" value="25">',
    '          <label style="margin-top:9px">滚动间隔 <b id="intVal">100</b> ms</label>',
    '          <input type="range" id="intRange" min="16" max="800" step="8" value="100">',
    '        </div>',
    '        <div class="field">',
    '          <label>翻页等待 <b id="waitVal">3</b> 秒（随机浮动）</label>',
    '          <input type="range" id="waitRange" min="1" max="30" step="1" value="3">',
    '        </div>',
    '        <label class="check"><input type="checkbox" id="autoNext"><span>自动翻页（下一页 / 下一章）</span></label>',
    '        <label class="check"><input type="checkbox" id="autoReload"><span>卡住时自动刷新并恢复进度</span></label>',
    '        <div class="field">',
    '          <label>翻页按钮定位</label>',
    '          <div class="calib">',
    '            <button class="linkbtn" id="pickNext">校准「下一页」</button>',
    '            <button class="linkbtn" id="clearNext">清除校准</button>',
    '          </div>',
    '          <div class="hint">自动翻页找不到按钮时，点「校准」再点页面上的「下一页」，脚本会记住它。</div>',
    '        </div>',
    '      </div>',
    '      <div class="pane" data-pane="video" hidden>',
    '        <div class="field">',
    '          <label>播放倍速 <b id="rateVal">1</b>×（最高 2×）</label>',
    '          <div class="mini-seg" id="rateSeg">',
    '            <button data-rate="1">1×</button>',
    '            <button data-rate="1.5">1.5×</button>',
    '            <button data-rate="2">2×</button>',
    '          </div>',
    '          <div class="hint">播放期间不滚动、不切页；最高 2×，如遇人机验证请保持 1×。</div>',
    '        </div>',
    '        <label class="check"><input type="checkbox" id="muted"><span>静音播放（建议开启，利于自动播放）</span></label>',
    '        <label class="check"><input type="checkbox" id="autoNextVideo"><span>播完自动切换下一集</span></label>',
    '        <label class="check"><input type="checkbox" id="antiPause"><span>防暂停 / 掉线自动恢复</span></label>',
    '      </div>',
    '      <div class="pane" data-pane="misc" hidden>',
    '        <label class="check"><input type="checkbox" id="spoofVisible"><span>伪装页面可见 / 始终有焦点</span></label>',
    '        <label class="check"><input type="checkbox" id="autoResume"><span>刷新或重开后自动继续</span></label>',
    '        <label class="check"><input type="checkbox" id="showLog"><span>显示运行日志</span></label>',
    '        <div class="log" id="logBox"></div>',
    '        <div class="tip">刷书：请先打开能正常阅读的正文页；刷视频：请进入视频播放页。脚本只做页面自动化，不会代替你提交任务。</div>',
    '      </div>',
    '    </div>',
    '    <div class="ft">v0.5.0 · 个人学习辅助 · Alt+Shift+C 显隐面板</div>',
    '  </div>',
    '  <div class="ball" id="ball" hidden>',
    '    <span class="ring"></span>',
    '    <span class="ball-ico" id="ballIco">阅</span>',
    '  </div>',
    '</div>'
  ].join('\n');

  const uiPref = Object.assign({ left: null, top: null, min: false, hidden: false }, gmGet(UI_KEY, {}));

  function saveUiPref() {
    gmSet(UI_KEY, uiPref);
  }

  function createUI() {
    if (!IS_TOP || ui) return;
    if (document.getElementById('cx-helper-host')) return;

    const host = document.createElement('div');
    host.id = 'cx-helper-host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';

    let root = host;
    try {
      root = host.attachShadow({ mode: 'open' });
    } catch (e) {
      root = host;
    }
    root.innerHTML = PANEL_HTML;
    (document.body || document.documentElement).appendChild(host);

    const byId = function (id) {
      return root.getElementById ? root.getElementById(id) : root.querySelector('#' + id);
    };

    const panel = byId('panel');
    const ball = byId('ball');

    /* ---------- 面板位置 / 收起 / 隐藏 ---------- */

    function setMin(min) {
      uiPref.min = !!min;
      saveUiPref();
      panel.hidden = !!min;
      ball.hidden = !min;
    }

    function showPanel() {
      host.style.display = '';
      uiPref.hidden = false;
      saveUiPref();
    }

    function hidePanel() {
      host.style.display = 'none';
      uiPref.hidden = true;
      saveUiPref();
      log('面板已隐藏，按 Alt+Shift+C 重新打开');
    }

    if (uiPref.left !== null && uiPref.top !== null) {
      const left = Math.max(4, Math.min(window.innerWidth - 80, Number(uiPref.left) || 0));
      const top = Math.max(4, Math.min(window.innerHeight - 60, Number(uiPref.top) || 0));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
    }
    if (uiPref.min) setMin(true);
    if (uiPref.hidden) host.style.display = 'none';

    (function makeDraggable() {
      const hd = byId('hd');
      let dragging = false;
      let sx = 0;
      let sy = 0;
      let ox = 0;
      let oy = 0;

      function onMove(e) {
        if (!dragging) return;
        let nx = ox + e.clientX - sx;
        let ny = oy + e.clientY - sy;
        nx = Math.max(0, Math.min(window.innerWidth - 90, nx));
        ny = Math.max(0, Math.min(window.innerHeight - 44, ny));
        panel.style.left = nx + 'px';
        panel.style.top = ny + 'px';
      }

      function onUp() {
        if (!dragging) return;
        dragging = false;
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        const r = panel.getBoundingClientRect();
        uiPref.left = Math.round(r.left);
        uiPref.top = Math.round(r.top);
        saveUiPref();
      }

      hd.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('button')) return;
        const r = panel.getBoundingClientRect();
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        ox = r.left;
        oy = r.top;
        panel.style.right = 'auto';
        panel.style.left = ox + 'px';
        panel.style.top = oy + 'px';
        e.preventDefault();
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
      });
    })();

    /* ---------- 选项卡 ---------- */

    function selectTab(name) {
      Array.prototype.forEach.call(root.querySelectorAll('[data-tab]'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-tab') === name);
      });
      Array.prototype.forEach.call(root.querySelectorAll('[data-pane]'), function (p) {
        p.hidden = p.getAttribute('data-pane') !== name;
      });
    }

    Array.prototype.forEach.call(root.querySelectorAll('[data-tab]'), function (b) {
      b.addEventListener('click', function () {
        selectTab(b.getAttribute('data-tab'));
      });
    });

    /* ---------- 控件联动 ---------- */

    function setRange(id, val) {
      const el = byId(id);
      if (!el) return;
      if (root.activeElement !== el) el.value = val;
    }

    function refresh() {
      const mode = state.running ? state.mode : cfg.mode;
      Array.prototype.forEach.call(root.querySelectorAll('[data-mode]'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-mode') === mode);
      });

      Array.prototype.forEach.call(root.querySelectorAll('[data-speed]'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-speed') === cfg.speed);
      });
      byId('customSpeed').hidden = cfg.speed !== 'custom';

      setRange('stepRange', cfg.step);
      byId('stepVal').textContent = cfg.step;
      setRange('intRange', cfg.interval);
      byId('intVal').textContent = cfg.interval;
      setRange('waitRange', cfg.waitMin);
      byId('waitVal').textContent = cfg.waitMin;
      byId('rateVal').textContent = String(normalizeRate(cfg.rate));

      Array.prototype.forEach.call(root.querySelectorAll('[data-rate]'), function (b) {
        const v = Number(b.getAttribute('data-rate'));
        b.classList.toggle('on', Math.abs(v - Number(cfg.rate)) < 0.01);
      });

      const checks = [
        ['autoNext', cfg.autoNext],
        ['autoReload', cfg.autoReload],
        ['muted', cfg.muted],
        ['autoNextVideo', cfg.autoNextVideo],
        ['antiPause', cfg.antiPause],
        ['spoofVisible', cfg.spoofVisible],
        ['autoResume', cfg.autoResume],
        ['showLog', cfg.showLog]
      ];
      checks.forEach(function (pair) {
        const el = byId(pair[0]);
        if (el) el.checked = !!pair[1];
      });

      const savedSel = cfg.nextSel && cfg.nextSel[location.hostname];
      const clearBtn = byId('clearNext');
      if (clearBtn) {
        clearBtn.disabled = !savedSel;
        clearBtn.title = savedSel || '当前页面尚未校准';
      }

      byId('logBox').style.display = cfg.showLog ? '' : 'none';
    }

    Array.prototype.forEach.call(root.querySelectorAll('[data-mode]'), function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        const mode = b.getAttribute('data-mode');
        if (mode === 'homework') {
          log('自动完成作业模块仅保留框架，暂未实现', 'warn');
          return;
        }
        changeMode(mode);
        if (mode === 'book' || mode === 'video') selectTab(mode);
        refresh();
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll('[data-speed]'), function (b) {
      b.addEventListener('click', function () {
        const name = b.getAttribute('data-speed');
        cfg.speed = name;
        if (SPEED_PRESETS[name]) {
          cfg.step = SPEED_PRESETS[name].step;
          cfg.interval = SPEED_PRESETS[name].interval;
        }
        saveCfg();
        refresh();
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll('[data-rate]'), function (b) {
      b.addEventListener('click', function () {
        cfg.rate = normalizeRate(b.getAttribute('data-rate'));
        saveCfg();
        refresh();
      });
    });

    function bindSlider(id, apply) {
      const el = byId(id);
      if (!el) return;
      el.addEventListener('input', function () {
        apply(Number(el.value));
        saveCfg();
        refresh();
        if (ui && ui.tick) ui.tick();
      });
    }

    bindSlider('stepRange', function (v) {
      cfg.step = Math.max(1, v);
      cfg.speed = 'custom';
    });
    bindSlider('intRange', function (v) {
      cfg.interval = Math.max(16, v);
      cfg.speed = 'custom';
    });
    bindSlider('waitRange', function (v) {
      cfg.waitMin = Math.max(1, v);
      cfg.waitMax = Math.max(cfg.waitMin, Math.round(cfg.waitMin * 1.4));
    });

    function bindCheck(id, key, after) {
      const el = byId(id);
      if (!el) return;
      el.addEventListener('change', function () {
        cfg[key] = !!el.checked;
        saveCfg();
        if (after) after(!!el.checked);
        refresh();
      });
    }

    bindCheck('autoNext', 'autoNext');
    bindCheck('autoReload', 'autoReload');
    bindCheck('muted', 'muted');
    bindCheck('autoNextVideo', 'autoNextVideo');
    bindCheck('antiPause', 'antiPause');
    bindCheck('autoResume', 'autoResume');
    bindCheck('showLog', 'showLog', function () {
      byId('logBox').style.display = cfg.showLog ? '' : 'none';
    });
    bindCheck('spoofVisible', 'spoofVisible', function (on) {
      log(on ? '伪装可见已开启，刷新页面后完全生效' : '伪装可见已关闭，刷新页面后恢复原生行为', 'warn');
    });

    byId('pickNext').addEventListener('click', function () {
      BookEngine.calibrate();
    });
    byId('clearNext').addEventListener('click', function () {
      BookEngine.clearCalibration();
      refresh();
    });

    byId('btnMin').addEventListener('click', function () { setMin(true); });
    byId('btnHide').addEventListener('click', hidePanel);
    ball.addEventListener('click', function () { setMin(false); });

    byId('btnRun').addEventListener('click', function () {
      if (state.running) stopRun('手动停止');
      else startRun();
    });

    /* ---------- 日志 ---------- */

    function pushLog(item) {
      const box = byId('logBox');
      if (!box) return;
      const line = document.createElement('div');
      line.className = 'log-line ' + (item.level || 'info');
      const d = new Date(item.t || Date.now());
      line.textContent = '[' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '] ' + item.msg;
      box.appendChild(line);
      while (box.children.length > 120) box.removeChild(box.firstChild);
      box.scrollTop = box.scrollHeight;
    }

    /* ---------- 状态刷新 ---------- */

    function tick() {
      if (!panel) return;
      byId('dot').className = 'dot ' + (state.level || 'idle');
      byId('statusText').textContent = state.statusText;
      byId('elapsed').textContent = fmtClock(state.running ? (Date.now() - state.startedAt) : state.elapsed);
      const btn = byId('btnRun');
      btn.textContent = state.running ? '停止刷时长' : '开始刷时长';
      btn.classList.toggle('stop', state.running);
      const ico = byId('ballIco');
      if (ico) ico.textContent = state.running ? '■' : '阅';
      if (ball) ball.classList.toggle('running', state.running);
    }

    ui = {
      tick: tick,
      refresh: refresh,
      pushLog: pushLog,
      selectTab: selectTab,
      showPanel: showPanel,
      hidePanel: hidePanel,
      setMin: setMin,
      host: host,
      panel: panel,
      ball: ball
    };

    logBuf.forEach(pushLog);
    selectTab(cfg.mode === 'video' ? 'video' : 'book');
    refresh();
    tick();
  }

  function togglePanel() {
    if (!ui) {
      createUI();
      return;
    }
    if (ui.host.style.display === 'none') {
      ui.showPanel();
      if (ui.panel.hidden) ui.setMin(false);
      return;
    }
    if (ui.panel.hidden) {
      ui.setMin(false);
      ui.showPanel();
      return;
    }
    ui.hidePanel();
  }

  /* ======================================================================
   * 8. 刷书引擎
   * ==================================================================== */

  const BookEngine = (function () {
    let active = false;
    let ticker = null;
    let waitHandle = null;
    let scroller = null;
    let turning = false;
    let stall = 0;
    let emptyTicks = 0;
    let lastTick = 0;
    let turnToken = 0;
    let targetFrame = null;
    let frameDefer = false;
    let picking = false;
    let cancelPick = null;

    const NEXT_SELECTORS = [
      '.next',
      '#next',
      '.nextPage',
      '#nextPage',
      '.page-next',
      '.next-page',
      '.reader-next',
      '.btn-next',
      '.nextBtn',
      '.next-btn',
      '[class*="nextPage"]',
      '[class*="pageNext"]',
      '[class*="page-next"]',
      '[class*="next-page"]',
      '[class*="nextBtn"]',
      '[class*="next-btn"]',
      '[id*="nextPage"]',
      '[id*="next-page"]',
      'a[title*="下一页"]',
      'a[title*="下一章"]',
      'a[title*="下一节"]',
      'a[aria-label*="下一页"]',
      'a[aria-label*="下一章"]',
      'button[aria-label*="下一页"]'
    ];

    const NEXT_WORDS = ['下一页', '下一頁', '下一章', '下一节', '下一節', '下一讲', '下一課', '下一课', '下一部分', '下一单元', '下一單元', '下一屏', '后一页', '继续阅读'];
    const BAD_CONTAINER = /(comment|comments|reply|pinglun|evaluate|discuss|footer|site-nav|navbar)/i;
    const END_TEXT = /(阅读完成|已完成阅读|已读完|恭喜.{0,8}完成|全部读完|阅读任务已完成)/;
    const KNOWN_SCROLLERS = '.reader-content, .read-content, #reader, .book-content, .chapter-content, .contentBox, .newwrap, .readContent';

    function frameDoc() {
      if (!targetFrame || !targetFrame.isConnected) return null;
      try { return targetFrame.contentDocument || null; } catch (e) { return null; }
    }

    function docOf() {
      return frameDoc() || document;
    }

    function winOf(doc) {
      return (doc && doc.defaultView) || window;
    }

    function esc(s) {
      try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'); }
      catch (e) { return String(s); }
    }

    function pickReaderFrame() {
      if (!IS_TOP) return null;
      let best = null;
      let bestArea = 0;
      try {
        const frames = document.querySelectorAll('iframe');
        for (let i = 0; i < frames.length; i++) {
          const f = frames[i];
          if (!isVisible(f)) continue;
          const r = f.getBoundingClientRect();
          if (r.width < 240 || r.height < 180) continue;
          if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
          const area = r.width * r.height;
          if (area > bestArea) {
            bestArea = area;
            best = f;
          }
        }
      } catch (e) { /* ignore */ }
      return bestArea > window.innerWidth * window.innerHeight * 0.35 ? best : null;
    }

    function frameHasHelper(f) {
      try {
        const d = f.contentDocument;
        return !!(d && d.documentElement && d.documentElement.getAttribute('data-cx-helper') === '1');
      } catch (e) {
        return false;
      }
    }

    function isWindowScroller(el) {
      const d = (el && el.ownerDocument) || document;
      return el === d.scrollingElement || el === d.documentElement || el === d.body;
    }

    function isScrollableEl(el) {
      if (!el || !el.isConnected || isWindowScroller(el)) return false;
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      let cs;
      try { cs = win.getComputedStyle(el); } catch (e) { return false; }
      if (!cs) return false;
      const oy = cs.overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
      let rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { return false; }
      if (rect.width < 120 || rect.height < 140) return false;
      return (el.scrollHeight - el.clientHeight) > 160;
    }

    function collectScrollers(doc) {
      doc = doc || docOf();
      const out = [];
      try {
        const known = doc.querySelectorAll(KNOWN_SCROLLERS);
        for (let i = 0; i < known.length; i++) {
          if (isScrollableEl(known[i])) out.push(known[i]);
        }
      } catch (e) { /* ignore */ }
      if (out.length) return out;
      try {
        const all = doc.querySelectorAll('div,section,main,article,td');
        for (let i = 0; i < all.length && i < 3000; i++) {
          if (isScrollableEl(all[i])) out.push(all[i]);
        }
      } catch (e) { /* ignore */ }
      return out;
    }

    function findScroller(doc) {
      doc = doc || docOf();
      if (!doc) return null;
      const win = winOf(doc);
      const cands = collectScrollers(doc);
      let best = null;
      let bestScore = 0;
      for (let i = 0; i < cands.length; i++) {
        const el = cands[i];
        let rect;
        try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
        const score = Math.min(rect.height, win.innerHeight) * 2 + Math.min(el.scrollHeight, 200000) / 10;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      if (best) return best;
      const se = doc.scrollingElement || doc.documentElement;
      if (se && (se.scrollHeight - win.innerHeight) > 100) return se;
      return null;
    }

    function probeScrollable(doc) {
      doc = doc || docOf();
      if (!doc) return null;
      const win = winOf(doc);
      const se = doc.scrollingElement || doc.documentElement;
      const list = [se].concat(collectScrollers(doc));
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        if (!el) continue;
        const winScroller = isWindowScroller(el);
        const before = winScroller ? (win.scrollY || 0) : el.scrollTop;
        let after = before;
        try {
          if (winScroller) win.scrollTo(0, before + 8);
          else el.scrollTop = before + 8;
          after = winScroller ? (win.scrollY || 0) : el.scrollTop;
        } catch (e) { /* ignore */ }
        try {
          if (winScroller) win.scrollTo(0, before);
          else el.scrollTop = before;
        } catch (e) { /* ignore */ }
        if (after > before + 0.5) return el;
      }
      return null;
    }

    function getScroll(el) {
      if (!el) return 0;
      if (isWindowScroller(el)) {
        const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        return win.scrollY || win.pageYOffset || 0;
      }
      return el.scrollTop;
    }

    function maxScroll(el) {
      if (!el) return 0;
      if (isWindowScroller(el)) {
        const doc = el.ownerDocument || document;
        const win = doc.defaultView || window;
        const se = doc.scrollingElement || doc.documentElement;
        return Math.max(0, se.scrollHeight - win.innerHeight);
      }
      return Math.max(0, el.scrollHeight - el.clientHeight);
    }

    function setScroll(el, value) {
      if (!el) return;
      const v = Math.max(0, Math.round(value));
      if (isWindowScroller(el)) {
        const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        win.scrollTo(0, v);
      } else {
        el.scrollTop = v;
      }
    }

    function signature(doc) {
      doc = doc || docOf();
      const parts = [];
      try { parts.push(doc.location ? doc.location.href : ''); } catch (e) { parts.push(''); }
      try { parts.push(doc.title || ''); } catch (e) { /* ignore */ }
      const el = scroller;
      if (el && el.ownerDocument === doc) {
        parts.push(String(el.scrollHeight));
        let ps = null;
        try { ps = el.querySelectorAll('p'); } catch (e) { ps = null; }
        if (ps && ps.length) {
          parts.push(String(ps.length));
          parts.push((ps[0].textContent || '').slice(0, 40));
          parts.push((ps[ps.length - 1].textContent || '').slice(0, 40));
        }
        try {
          const txt = el.innerText || el.textContent || '';
          parts.push(String(txt.length));
          parts.push(txt.slice(0, 80));
          parts.push(txt.slice(-80));
        } catch (e) { /* ignore */ }
      } else if (doc.body) {
        parts.push(String((doc.body.textContent || '').length));
      }
      return parts.join('|');
    }

    function scoreNext(el) {
      let s = 0;
      const cls = (el.getAttribute('class') || '') + ' ' + (el.id || '');
      if (/next|page|paging/i.test(cls)) s += 600;
      if (el.tagName === 'A' || el.tagName === 'BUTTON') s += 150;
      if (el.getAttribute('role') === 'button') s += 100;
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      if (r) {
        if (r.top >= 0 && r.bottom <= win.innerHeight) s += 200;
        if (r.top > win.innerHeight * 0.5) s += 100;
      }
      return s;
    }

    function findNextButton(doc) {
      doc = doc || docOf();
      if (!doc) return null;
      const seen = new Set();
      const scored = [];

      function add(el, base) {
        if (!el || seen.has(el)) return;
        if (!isClickable(el)) return;
        if (inBadContainer(el, BAD_CONTAINER)) return;
        let t = '';
        try { t = cleanLabel(el.innerText || el.textContent || ''); } catch (e) { t = ''; }
        if (t && /(上一页|上一章|上一节)/.test(t)) return;
        seen.add(el);
        scored.push({ el: el, score: base + scoreNext(el) });
      }

      const host = location.hostname;
      const saved = cfg.nextSel && cfg.nextSel[host];
      if (saved) {
        try {
          const el = doc.querySelector(saved);
          if (el) add(el, 2000);
        } catch (e) { /* ignore */ }
      }

      findClickableByWords(NEXT_WORDS, BAD_CONTAINER, doc, 24).forEach(function (el) {
        add(el, 200);
      });

      for (let i = 0; i < NEXT_SELECTORS.length; i++) {
        let els;
        try { els = doc.querySelectorAll(NEXT_SELECTORS[i]); } catch (e) { continue; }
        for (let j = 0; j < els.length && j < 8; j++) add(els[j], 80);
      }

      try {
        const labeled = doc.querySelectorAll('[aria-label],[title]');
        for (let i = 0; i < labeled.length && i < 600; i++) {
          if (labelMatchesWords(labeled[i], NEXT_WORDS)) add(labeled[i], 180);
        }
      } catch (e) { /* ignore */ }

      if (!scored.length) return null;
      scored.sort(function (a, b) { return b.score - a.score; });
      return scored[0].el;
    }

    function detectEnd(doc) {
      doc = doc || docOf();
      try {
        const txt = (doc.body ? (doc.body.innerText || doc.body.textContent) : '').replace(/\s+/g, '');
        return END_TEXT.test(txt.slice(-8000));
      } catch (e) {
        return false;
      }
    }

    function schedule(ms) {
      if (ticker) {
        ticker.clear();
        ticker = null;
      }
      ticker = Scheduler.after(ms, tick);
    }

    function resumeProgress() {
      const frac = Number(run.progress);
      if (!isFinite(frac) || frac <= 0.01 || frac >= 0.99) {
        if (run.progress) {
          run.progress = 0;
          gmSet(RUN_KEY, run);
        }
        return false;
      }
      run.progress = 0;
      gmSet(RUN_KEY, run);
      Scheduler.after(900, function () {
        if (!active || !state.running || state.mode !== 'book') return;
        const doc = docOf();
        const el = (scroller && scroller.isConnected && scroller.ownerDocument === doc) ? scroller : findScroller(doc);
        if (!el) return;
        scroller = el;
        const max = maxScroll(el);
        if (max <= 0) return;
        setScroll(el, frac * max);
        log('已恢复到上次进度 ' + Math.round(frac * 100) + '%');
      });
      return true;
    }

    function tick() {
      ticker = null;
      lastTick = Date.now();
      if (!active || !state.running || state.mode !== 'book' || turning) return;

      if (frameDefer) {
        const f = pickReaderFrame();
        if (!f) {
          frameDefer = false;
          log('子框架已消失，主页面接管刷书');
          schedule(100);
        } else if (!frameHasHelper(f)) {
          frameDefer = false;
          targetFrame = f;
          scroller = null;
          log('子框架内未检测到实例，主页面直接接管');
          schedule(100);
        } else {
          setStatus('正文在子框架中，由子框架继续刷书…', 'wait');
          schedule(3000);
        }
        return;
      }

      if (targetFrame) {
        if (!targetFrame.isConnected) {
          targetFrame = null;
          scroller = null;
          log('子框架已消失，主页面接管刷书');
          schedule(100);
          return;
        }
        if (frameHasHelper(targetFrame)) {
          targetFrame = null;
          scroller = null;
          frameDefer = true;
          log('检测到子框架内实例，交由它继续刷书');
          setStatus('正文在子框架中，由子框架继续刷书…', 'wait');
          schedule(3000);
          return;
        }
        if (!frameDoc()) {
          setStatus('等待子框架加载…', 'wait');
          schedule(1000);
          return;
        }
      }

      const doc = docOf();
      if (!scroller || !scroller.isConnected || scroller.ownerDocument !== doc) {
        scroller = findScroller(doc);
      }

      if (!scroller) {
        if (!targetFrame && IS_TOP) {
          const f = pickReaderFrame();
          if (f) {
            if (frameHasHelper(f)) {
              frameDefer = true;
              log('检测到正文位于子框架，由子框架内实例继续刷书');
              setStatus('正文在子框架中，由子框架继续刷书…', 'wait');
              schedule(3000);
            } else {
              targetFrame = f;
              scroller = null;
              log('检测到正文位于子框架，主页面直接控制框架内页面');
              setStatus('正在控制子框架刷书…', 'run');
              schedule(500);
            }
            return;
          }
        }
        setStatus('等待正文加载…', 'wait');
        schedule(1200);
        return;
      }

      const max = maxScroll(scroller);
      if (max <= 0) {
        emptyTicks += 1;
        if (emptyTicks >= 3) {
          emptyTicks = 0;
          onBottom();
          return;
        }
        setStatus('等待正文加载…', 'wait');
        schedule(1000);
        return;
      }
      emptyTicks = 0;

      const cur = getScroll(scroller);
      if (max - cur <= 8) {
        onBottom();
        return;
      }

      const step = Math.max(1, Math.round(Number(cfg.step || 25) * (0.9 + Math.random() * 0.2)));
      setScroll(scroller, Math.min(max, cur + step));

      const nowTop = getScroll(scroller);
      if (nowTop <= cur + 0.5) {
        stall++;
        if (stall >= 6) {
          log('滚动似乎无效，重新定位正文容器', 'warn');
          stall = 0;
          scroller = probeScrollable(doc) || findScroller(doc);
        }
      } else {
        stall = 0;
      }

      const pct = Math.min(100, Math.round((nowTop / Math.max(1, max)) * 100));
      setStatus('刷书中 · ' + pct + '%', 'run');
      schedule(Math.max(16, Number(cfg.interval) || 100));
    }

    function onBottom() {
      if (turning) return;
      turning = true;
      if (ticker) {
        ticker.clear();
        ticker = null;
      }

      if (!cfg.autoNext) {
        turning = false;
        finishRun('已到页面底部（自动翻页已关闭）');
        return;
      }
      if (!findNextButton() && detectEnd()) {
        turning = false;
        finishRun('检测到阅读任务已完成');
        return;
      }

      const min = Number(cfg.waitMin) || 3;
      const max = Math.max(min, Number(cfg.waitMax) || min);
      const wait = rnd(min, max);
      setStatus('已到页底，' + wait + ' 秒后翻页…', 'wait');
      log('到达页底，' + wait + ' 秒后尝试翻页');

      if (waitHandle) waitHandle.clear();
      waitHandle = Scheduler.after(wait * 1000, function () {
        waitHandle = null;
        if (!active || !state.running || state.mode !== 'book') {
          turning = false;
          return;
        }
        pageTurn();
      });
    }

    function pageTurn() {
      if (waitHandle) {
        waitHandle.clear();
        waitHandle = null;
      }
      const myToken = ++turnToken;
      const doc = docOf();
      if (scroller && scroller.ownerDocument !== doc) scroller = findScroller(doc);
      const before = signature(doc);
      const btn = findNextButton(doc);
      if (btn) {
        let desc = labelOf(btn) || '下一页';
        let cls = '';
        try { cls = (btn.getAttribute('class') || '').trim(); } catch (e) { cls = ''; }
        log('翻页：点击「' + desc + '」' + (cls ? '（.' + cls.split(/\s+/).slice(0, 2).join('.') + '）' : ''));
        clickEl(btn);
      } else {
        log('未找到翻页按钮，尝试继续滚到底部', 'warn');
        setScroll(scroller, maxScroll(scroller) + 2000);
      }

      waitUntil(function () {
        const d = docOf();
        if (scroller && !scroller.isConnected) scroller = findScroller(d);
        return signature(d) !== before;
      }, 12000).then(function (changed) {
        if (myToken !== turnToken) return;
        if (!active || !state.running || state.mode !== 'book') {
          turning = false;
          return;
        }
        if (changed) {
          turning = false;
          stall = 0;
          state.reloads = 0;
          run.reloads = 0;
          scroller = findScroller(docOf());
          log('翻页成功，继续刷书');
          setStatus('翻页成功，继续…', 'run');
          schedule(900);
        } else {
          log('翻页没有响应', 'warn');
          if (detectEnd()) {
            turning = false;
            finishRun('检测到阅读任务已完成');
            return;
          }
          if (cfg.autoReload) {
            reloadRecover();
          } else {
            turning = false;
            finishRun('翻页失败（自动刷新已关闭）');
          }
        }
      });
    }

    function waitUntil(fn, timeout) {
      return new Promise(function (resolve) {
        const start = Date.now();
        let handle = null;
        handle = Scheduler.every(500, function () {
          if (!active || !state.running || state.mode !== 'book' || Date.now() - start > timeout) {
            if (handle) handle.clear();
            resolve(false);
            return;
          }
          let ok = false;
          try { ok = !!fn(); } catch (e) { ok = false; }
          if (ok) {
            if (handle) handle.clear();
            resolve(true);
          }
        });
      });
    }

    function reloadRecover() {
      if (frameDefer) {
        turning = false;
        log('正文由子框架内实例负责，跳过整页刷新', 'warn');
        setStatus('等待子框架继续刷书…', 'wait');
        schedule(3000);
        return;
      }
      const max = maxScroll(scroller);
      const frac = max > 0 ? getScroll(scroller) / max : 1;
      state.reloads += 1;
      if (state.reloads > MAX_RELOADS) {
        turning = false;
        finishRun('自动刷新次数过多，已停止');
        return;
      }
      run.reloads = state.reloads;
      run.progress = Math.max(0, Math.min(1, frac));
      run.beat = Date.now();
      run.url = location.href;
      gmSet(RUN_KEY, run);
      log('页面卡住，3 秒后刷新恢复（第 ' + state.reloads + ' 次）', 'warn');
      setStatus('刷新恢复中…（第 ' + state.reloads + ' 次）', 'warn');
      window.setTimeout(function () {
        if (!state.running || state.mode !== 'book') return;
        location.reload();
      }, 3000);
    }

    function start() {
      if (active) return;
      active = true;
      turning = false;
      stall = 0;
      emptyTicks = 0;
      targetFrame = null;
      frameDefer = false;
      if (waitHandle) {
        waitHandle.clear();
        waitHandle = null;
      }
      lastTick = Date.now();

      if (IS_TOP) {
        const f = pickReaderFrame();
        if (f) {
          if (frameHasHelper(f)) {
            frameDefer = true;
            log('检测到正文位于子框架，由子框架内实例继续刷书');
            setStatus('正文在子框架中，由子框架继续刷书…', 'wait');
            schedule(3000);
            return;
          }
          targetFrame = f;
          scroller = null;
          log('检测到正文位于子框架，主页面直接控制框架内页面');
          setStatus('正在控制子框架刷书…', 'run');
          schedule(600);
          return;
        }
      }

      scroller = findScroller();
      log('刷书引擎启动' + (scroller ? '' : '（等待正文加载）'));
      setStatus(scroller ? '准备刷书…' : '等待正文加载…', scroller ? 'run' : 'wait');
      const resuming = scroller ? resumeProgress() : false;
      schedule(resuming ? 1600 : (scroller ? 500 : 1200));
    }

    function stop() {
      active = false;
      turnToken += 1;
      targetFrame = null;
      frameDefer = false;
      scroller = null;
      turning = false;
      stall = 0;
      emptyTicks = 0;
      if (waitHandle) {
        waitHandle.clear();
        waitHandle = null;
      }
      if (ticker) {
        ticker.clear();
        ticker = null;
      }
    }

    function wake() {
      if (!active || turning) return;
      schedule(120);
    }

    function reposition() {
      if (!active) return;
      scroller = null;
      stall = 0;
      if (!turning) schedule(300);
    }

    function watchdog() {
      if (!active || turning) return;
      if (Date.now() - lastTick > 4000) schedule(100);
    }

    /* ---------- 手动校准下一页按钮 ---------- */

    function cssPath(el, doc) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + esc(el.id);
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && node !== doc.body && node !== doc.documentElement) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift('#' + esc(node.id));
          break;
        }
        let cls = '';
        try { cls = (typeof node.className === 'string' ? node.className : '').trim(); } catch (e) { cls = ''; }
        const list = cls.split(/\s+/).filter(function (c) {
          return c && c.length < 40 && /^[A-Za-z_-][\w-]*$/.test(c) && !/(active|hover|focus|selected|current|show|open|disabled)/i.test(c);
        }).slice(0, 2);
        if (list.length) part += '.' + list.map(esc).join('.');
        const parent = node.parentElement;
        if (parent) {
          const sibs = Array.prototype.filter.call(parent.children, function (x) { return x.tagName === node.tagName; });
          if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    }

    function calibrate() {
      if (picking) {
        cancelCalibrate();
        return;
      }
      picking = true;
      const docs = [document];
      let fd = frameDoc();
      if (!fd && IS_TOP) {
        const f = pickReaderFrame();
        if (f && !frameHasHelper(f)) {
          try { fd = f.contentDocument; } catch (e) { fd = null; }
        }
      }
      if (fd && docs.indexOf(fd) < 0) docs.push(fd);
      const handlers = [];
      setStatus('请点击页面上的「下一页」按钮…', 'wait');
      log('校准模式：请点击正文下方的「下一页」按钮，按 Esc 取消');

      function finish() {
        picking = false;
        cancelPick = null;
        handlers.forEach(function (h) {
          try { h.doc.removeEventListener('click', h.click, true); } catch (e) { /* ignore */ }
          try { h.doc.removeEventListener('keydown', h.key, true); } catch (e) { /* ignore */ }
        });
      }

      cancelPick = finish;

      function onClick(ev) {
        const t = ev.target;
        if (!t || (t.closest && t.closest('#cx-helper-host'))) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        const doc = t.ownerDocument || document;
        const action = (t.closest && t.closest('a,button,[role="button"],li')) || t;
        const sel = cssPath(action, doc);
        if (sel) {
          cfg.nextSel = cfg.nextSel || {};
          cfg.nextSel[location.hostname] = sel;
          saveCfg();
          log('已记录翻页按钮定位：' + sel);
          setStatus('已记录翻页按钮，下次到达页底会优先使用', 'ok');
        } else {
          log('未能生成按钮定位，请重试', 'warn');
        }
        finish();
      }

      function onKey(ev) {
        if (ev.key === 'Escape') {
          log('已取消翻页按钮校准');
          setStatus('已取消校准', 'idle');
          finish();
        }
      }

      docs.forEach(function (doc) {
        const h = { doc: doc, click: onClick, key: onKey };
        handlers.push(h);
        try { doc.addEventListener('click', onClick, true); } catch (e) { /* ignore */ }
        try { doc.addEventListener('keydown', onKey, true); } catch (e) { /* ignore */ }
      });
    }

    function cancelCalibrate() {
      if (cancelPick) {
        const fn = cancelPick;
        cancelPick = null;
        fn();
      }
      picking = false;
      setStatus('已取消校准', 'idle');
    }

    function clearCalibration() {
      if (cfg.nextSel && cfg.nextSel[location.hostname]) {
        delete cfg.nextSel[location.hostname];
        saveCfg();
        log('已清除本页面的翻页按钮校准');
      }
    }

    return {
      start: start,
      stop: stop,
      wake: wake,
      reposition: reposition,
      watchdog: watchdog,
      calibrate: calibrate,
      clearCalibration: clearCalibration
    };
  })();

  /* ======================================================================
   * 9. 刷视频引擎
   * ==================================================================== */

  const VideoEngine = (function () {
    let active = false;
    let ticker = null;
    let current = null;
    let nextLock = 0;
    let lastTick = 0;
    let endTimer = null;
    let advanceFor = null;
    let advanceAt = 0;
    let lastPlayAt = 0;
    let lastDialogAt = 0;
    const bound = new WeakSet();
    const watched = new WeakMap();

    const BAD_CONTAINER = /(comment|comments|reply|pinglun|evaluate|discuss|footer|site-nav|navbar)/i;
    const NEXT_VIDEO_TEXT = /^(下一集|下一节|下一个|下一课|下一讲|下一章|下一个视频|下一段)[\s>»›\.…·]*$/;
    const GROUP_SELECTORS = [
      '.video-list li',
      '.videoList li',
      '.chapter-list li',
      '.chapterList li',
      '.catalog li',
      '.catalog-list li',
      '.posCatalog_select',
      '[class*="catalog"] [class*="item"]',
      '[class*="chapter"] [class*="item"]',
      '[class*="video-list"] [class*="item"]',
      '[class*="videoList"] [class*="item"]'
    ];

    /* v0.4：只允许“能直接看到 video 的顶层页面”统一控制视频。
       顶层会递归收集同源 iframe 里的视频；同源子框架不再各跑一份视频引擎，
       从根上避免多个实例同时点“下一集/下一节”造成连环切换。 */
    function collectDocs() {
      const out = [];
      const seen = [];
      function walk(doc, depth) {
        if (!doc || depth > 4) return;
        for (let i = 0; i < seen.length; i++) if (seen[i] === doc) return;
        seen.push(doc);
        out.push(doc);
        let frames = [];
        try { frames = doc.querySelectorAll('iframe'); } catch (e) { frames = []; }
        for (let i = 0; i < frames.length; i++) {
          let sub = null;
          try { sub = frames[i].contentDocument; } catch (e) { sub = null; }
          if (sub) walk(sub, depth + 1);
        }
      }
      walk(document, 0);
      return out;
    }

    function collectVideos() {
      const out = [];
      const docs = collectDocs();
      for (let d = 0; d < docs.length; d++) {
        let vs = [];
        try { vs = docs[d].querySelectorAll('video'); } catch (e) { vs = []; }
        for (let i = 0; i < vs.length; i++) {
          if (vs[i].isConnected) out.push(vs[i]);
        }
      }
      return out;
    }

    /* 将任意 iframe 里的元素坐标换算到当前窗口视口，用于判断“下一个视频”
       是否真的滚到了可见区域。 */
    function rectInTop(el) {
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { return null; }
      let win = el.ownerDocument && el.ownerDocument.defaultView;
      let guard = 0;
      while (win && win !== window && guard++ < 6) {
        let fe = null;
        try { fe = win.frameElement; } catch (e) { fe = null; }
        if (!fe) break;
        let fr;
        try { fr = fe.getBoundingClientRect(); } catch (e) { break; }
        r = {
          left: fr.left + r.left,
          top: fr.top + r.top,
          right: fr.left + r.right,
          bottom: fr.top + r.bottom,
          width: r.width,
          height: r.height
        };
        win = fe.ownerDocument && fe.ownerDocument.defaultView;
      }
      return r;
    }

    function docHasVideoHint(doc, depth) {
      if (!doc) return false;
      try {
        if (doc.querySelector('video')) return true;
        if (doc.querySelector('iframe.ans-insertvideo-online, iframe[src*="video"], iframe[src*="ananas"]')) return true;
      } catch (e) { /* ignore */ }
      if (depth <= 0) return false;
      let frames = [];
      try { frames = doc.querySelectorAll('iframe'); } catch (e) { return false; }
      for (let i = 0; i < frames.length; i++) {
        let sub = null;
        try { sub = frames[i].contentDocument; } catch (e) { sub = null; }
        if (sub && docHasVideoHint(sub, depth - 1)) return true;
      }
      return false;
    }

    function findVideoFrameLoose() {
      let frames = [];
      try { frames = document.querySelectorAll('iframe'); } catch (e) { return null; }
      let best = null;
      let bestArea = 0;
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (!isVisible(f)) continue;
        let r;
        try { r = f.getBoundingClientRect(); } catch (e) { continue; }
        if (r.width < 160 || r.height < 90) continue;
        let hint = '';
        try { hint = ((f.className || '') + ' ' + (f.id || '') + ' ' + (f.src || '') + ' ' + (f.name || '')); } catch (e) { hint = ''; }
        const known = /ans-insertvideo|video|ananas/i.test(hint);
        let hasVideo = false;
        try { hasVideo = docHasVideoHint(f.contentDocument, 2); } catch (e) { hasVideo = false; }
        if (!known && !hasVideo) continue;
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = f; }
      }
      return best;
    }

    function pick() {
      /* v0.4：只要当前视频还在、且没有播完，就始终刷它。 */
      if (current && current.isConnected && !current.ended) return current;

      const list = collectVideos();
      if (!list.length) return null;
      const vh = window.innerHeight || 700;
      let best = null;
      let bestScore = -1;
      let endedBest = null;
      let endedScore = -1;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (!v.isConnected) continue;
        let r = null;
        try { r = rectInTop(v); } catch (e) { r = null; }
        /* 隐藏的预加载播放器不参与选择，避免把下一任务点的隐藏视频提前播放。 */
        if (!r || r.width < 60 || r.height < 40) continue;
        let score = Math.min(r.width * r.height, 4000000) / 1000;
        let visible = 0;
        try {
          visible = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        } catch (e) { visible = 0; }
        if (visible > 0) score += 12000;
        if (!v.paused) score += 5000;
        if (v.readyState >= 2) score += 1000;
        if (v.ended) {
          /* 优先选择未结束的视频；全部结束（单视频页）时仍返回旧视频，
             让 tick 的结束处理继续工作。 */
          if (score > endedScore) { endedScore = score; endedBest = v; }
          continue;
        }
        score += 300;
        if (score > bestScore) { bestScore = score; best = v; }
      }
      return best || endedBest;
    }

    function findVisibleVideo(exclude) {
      const list = collectVideos();
      let best = null;
      let bestArea = 0;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (!v.isConnected || v === exclude || v.ended) continue;
        let r = null;
        try { r = rectInTop(v); } catch (e) { r = null; }
        if (!r || r.width < 80 || r.height < 60) continue;
        if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = v;
        }
      }
      return best;
    }

    /* 同一文档/多个任务点里可能同时加载了多个 video。
       只暂停“确实在播放的其他视频”，避免两个任务点同时计时、同时结束。 */
    function pauseOthers(keep) {
      const list = collectVideos();
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v === keep || !v.isConnected || v.ended || v.paused) continue;
        try { v.pause(); } catch (e) { /* ignore */ }
      }
    }

    function safePlay(v) {
      try {
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) { /* ignore */ }
    }

    function enforce(v) {
      if (!v || !state.running || state.mode !== 'video') return;
      try {
        const rate = normalizeRate(cfg.rate);
        if (Math.abs((v.playbackRate || 1) - rate) > 0.01) v.playbackRate = rate;
      } catch (e) { /* ignore */ }
      try {
        if (cfg.muted && !v.muted) v.muted = true;
        else if (!cfg.muted && v.muted) v.muted = false;
      } catch (e) { /* ignore */ }
      if (cfg.antiPause && v.paused && !v.ended) {
        const now = Date.now();
        if (now - lastPlayAt > 1500) {
          lastPlayAt = now;
          safePlay(v);
        }
      }
    }

    function schedule(ms) {
      if (ticker) {
        ticker.clear();
        ticker = null;
      }
      ticker = Scheduler.after(ms, tick);
    }

    function attach(v) {
      if (!v) return;
      const switched = current !== v;
      if (current && current !== v) {
        advanceFor = null;
        advanceAt = 0;
      }
      current = v;
      if (switched) pauseOthers(v);
      if (bound.has(v)) {
        enforce(v);
        return;
      }
      bound.add(v);

      v.addEventListener('ended', function () {
        if (!active || !state.running || state.mode !== 'video' || v !== current) return;
        watched.set(v, 1e9);
        queueAdvance('播放结束');
      });

      v.addEventListener('timeupdate', function () {
        if (v !== current) return;
        let t = 0;
        try { t = Number(v.currentTime) || 0; } catch (e) { t = 0; }
        const prev = watched.get(v) || 0;
        if (t > prev) watched.set(v, t);
      });

      v.addEventListener('pause', function () {
        if (!active || !state.running || state.mode !== 'video' || !cfg.antiPause || v !== current) return;
        Scheduler.after(500, function () {
          if (active && state.running && state.mode === 'video' && v === current && v.paused && !v.ended) {
            safePlay(v);
          }
        });
      });

      v.addEventListener('play', function () {
        if (v === advanceFor) {
          advanceFor = null;
          advanceAt = 0;
        }
        if (active && v === current) enforce(v);
      });
      v.addEventListener('ratechange', function () {
        if (active && state.running && v === current) enforce(v);
      });
      v.addEventListener('loadedmetadata', function () {
        if (v === advanceFor && !v.ended) {
          advanceFor = null;
          advanceAt = 0;
        }
        if (active && v === current) enforce(v);
      });

      let dur = 0;
      try { dur = Number(v.duration) || 0; } catch (e) { dur = 0; }
      log('已接管视频' + (dur > 0 ? '（' + fmtTime(dur) + '）' : ''));
      enforce(v);
    }

    /* v0.3：视频结束后只安排一次切换。切换期间不再滚动页面、不反复点按钮，
       避免短时间内的大量页面操作触发学习通的人机验证。 */
    function queueAdvance(reason) {
      if (!active || !state.running || state.mode !== 'video') return;
      const v = current;
      if (!v) {
        next(reason);
        return;
      }
      if (advanceFor === v && endTimer) return;
      if (nextLock && Date.now() - nextLock < 3000) {
        schedule(1000);
        return;
      }
      if (advanceFor === v && !endTimer) return;
      if (!cfg.autoNextVideo) {
        finishRun('视频已播放完（自动切换已关闭）');
        return;
      }
      advanceFor = v;
      advanceAt = Date.now();
      log('当前视频已完整播放，停留 3 秒后只切换一次');
      setStatus('视频播完，准备切换下一个…', 'wait');
      endTimer = Scheduler.after(3000, function () {
        endTimer = null;
        if (!active || !state.running || state.mode !== 'video') return;
        if (v !== current) return;

        let dur = 0;
        let cur = 0;
        try {
          dur = Number(v.duration) || 0;
          cur = Number(v.currentTime) || 0;
        } catch (e) { dur = 0; cur = 0; }

        const reallyEnded = v.ended || (isFinite(dur) && dur > 0 && cur >= dur - 0.8);
        if (!reallyEnded) {
          advanceFor = null;
          advanceAt = 0;
          const w = watched.get(v) || cur;
          log('复核发现视频尚未真正播完（已看 ' + fmtTime(w) + ' / ' + (dur > 0 ? fmtTime(dur) : '未知') + '），继续等待', 'warn');
          setStatus('视频尚未播完，继续播放…', 'wait');
          if (cfg.antiPause && v.paused && !v.ended) safePlay(v);
          schedule(1200);
          return;
        }
        const w = watched.get(v) || cur;
        if (isFinite(dur) && dur > 20 && w < Math.min(20, dur * 0.6)) {
          log('实际观看时长过短（' + fmtTime(w) + '），为避免风控暂不切换', 'warn');
          setStatus('观看时长异常，本次不自动切换', 'warn');
          finishRun('视频观看时长异常，已停止以规避风险');
          return;
        }
        advanceAt = Date.now();
        if (dismissTaskDialog()) {
          /* 点「下一节」会由平台自己跳转；这里不要紧跟着再点一次下一节。
             清掉本次推进标记，等新视频加载后 tick 会重新接管。 */
          advanceFor = null;
          advanceAt = 0;
          schedule(1500);
          return;
        }
        next(reason);
      });
    }

    function tick() {
      ticker = null;
      lastTick = Date.now();
      if (!active || !state.running || state.mode !== 'video') return;
      if (endTimer) {
        schedule(500);
        return;
      }

      const v = pick();
      if (!v) {
        /* 顶层拿不到 video 时，可能播放器在跨域 iframe 里；
           只提示，不自动点击，避免和子框架控制器抢操作。 */
        const loose = findVideoFrameLoose();
        if (loose) {
          if (Date.now() - lastChildStatusAt > 4000) {
            setStatus('视频在子框架中，由子框架继续播放…', 'wait');
          }
        } else {
          setStatus('等待视频加载…', 'wait');
        }
        schedule(1500);
        return;
      }

      if (v !== current) {
        current = v;
        attach(v);
      }
      if (advanceFor && (advanceFor !== v || !v.ended)) {
        advanceFor = null;
        advanceAt = 0;
      }
      enforce(v);

      let dur = 0;
      let cur = 0;
      try {
        dur = Number(v.duration) || 0;
        cur = Number(v.currentTime) || 0;
      } catch (e) { /* ignore */ }

      if (v.ended) {
        queueAdvance('播放结束');
        if (advanceFor === v && advanceAt && Date.now() - advanceAt > 30000) {
          log('切换后 30 秒仍未出现新视频，停止以免反复操作', 'warn');
          finishRun('切换后未检测到新视频，已停止');
          return;
        }
        schedule(1000);
        return;
      }

      if (isFinite(dur) && dur > 0) {
        const pct = Math.min(100, Math.round((cur / dur) * 100));
        setStatus('刷视频中 · ' + fmtTime(cur) + ' / ' + fmtTime(dur) + ' · ' + pct + '% · ' + normalizeRate(cfg.rate) + '×', 'run');
        if (dur - cur <= 0.4 && dur > 2) {
          setStatus('视频即将播完，等待自然结束…', 'wait');
        }
      } else {
        setStatus('刷视频中…', 'run');
      }

      schedule(1000);
    }

    function clickDocs() {
      const docs = collectDocs();
      const out = [];
      const curDoc = current && current.ownerDocument;
      if (curDoc) out.push(curDoc);
      for (let i = 0; i < docs.length; i++) {
        if (docs[i] !== curDoc) out.push(docs[i]);
      }
      return out;
    }

    /* v0.5：视频播完后平台会弹「当前章节还有任务点未完成，是否去完成？」。
       这个弹窗不会自己消失，会挡住后续任务点；这里只点弹窗里的「下一节」，
       不碰页面侧边栏里普通的「下一节」。 */
    function isDialogContainer(el) {
      try {
        const win = el.ownerDocument.defaultView || window;
        const cs = win.getComputedStyle(el);
        if (cs.position === 'fixed' || cs.position === 'absolute') return true;
        const z = parseInt(cs.zIndex, 10);
        if (!isNaN(z) && z >= 100) return true;
      } catch (e) { /* ignore */ }
      const hint = ((typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || ''));
      return /(dialog|modal|layer|popup|confirm|tips|mask)/i.test(hint);
    }

    function dismissTaskDialog() {
      if (!active || !state.running || state.mode !== 'video') return false;
      if (Date.now() - lastDialogAt < 5000) return false;
      const docs = clickDocs();
      for (let d = 0; d < docs.length; d++) {
        const doc = docs[d];
        let nodes;
        try {
          nodes = doc.querySelectorAll('a,button,[role="button"],span,div');
        } catch (e) { continue; }
        const max = Math.min(nodes.length, 8000);
        for (let i = 0; i < max; i++) {
          const el = nodes[i];
          /* 只检查叶子节点/按钮，避免对每个大容器做 textContent 造成卡顿。 */
          if (el.children && el.children.length > 0 && !/^(A|BUTTON)$/i.test(el.tagName)) continue;
          let text = '';
          try { text = cleanLabel(el.textContent || el.innerText || ''); } catch (e) { text = ''; }
          if (!/^下一节[\s>»›\.…·]*$/.test(text)) continue;
          if (!isVisible(el) || !isClickable(el)) continue;
          let p = el;
          let inDialog = false;
          for (let depth = 0; depth < 8 && p; depth++) {
            if (isDialogContainer(p)) {
              let full = '';
              try { full = (p.innerText || p.textContent || '').replace(/\s+/g, ''); } catch (e) { full = ''; }
              if (/任务点未完成|是否去完成/.test(full)) { inDialog = true; break; }
            }
            p = p.parentElement;
          }
          if (!inDialog) continue;
          clickEl(el, { noScroll: true });
          lastDialogAt = Date.now();
          log('已点击弹窗「下一节」，关闭“任务点未完成”提示');
          setStatus('已关闭任务点提示，继续下一节…', 'run');
          return true;
        }
      }
      return false;
    }

    function clickNextButton() {
      const docs = clickDocs();
      for (let d = 0; d < docs.length; d++) {
        const el = findClickableByText(NEXT_VIDEO_TEXT, BAD_CONTAINER, docs[d]);
        if (!el) continue;
        clickEl(el, { noScroll: true });
        log('点击「' + (labelOf(el) || '下一集') + '」');
        return true;
      }
      return false;
    }

    function activeIndex(items) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const cls = (it.getAttribute('class') || '') + ' ' + (it.getAttribute('aria-current') || '');
        if (/(^|[\s_-])(active|current|playing|selected|cur|on)([\s_-]|$)/i.test(cls)) return i;
        if (it.getAttribute('aria-selected') === 'true') return i;
      }
      return -1;
    }

    function clickNextItem() {
      const docs = clickDocs();
      for (let d = 0; d < docs.length; d++) {
        const doc = docs[d];
        for (let s = 0; s < GROUP_SELECTORS.length; s++) {
          let items;
          try {
            items = Array.prototype.slice.call(doc.querySelectorAll(GROUP_SELECTORS[s])).filter(isVisible);
          } catch (e) { continue; }
          if (items.length < 2) continue;
          const idx = activeIndex(items);
          if (idx < 0 || idx >= items.length - 1) continue;
          const target = items[idx + 1];
          const clickable = target.querySelector('a,span') || target;
          clickEl(clickable, { noScroll: true });
          log('点击目录下一项：' + (labelOf(target) || ''));
          return true;
        }
      }
      return false;
    }

    /* v0.4：任务点标签可能位于顶层，也可能在 #iframe 里。
       遍历所有同源文档，把坐标换算到顶层后，取当前视频正下方最近的一个。 */
    function nextTaskMark() {
      const v = current;
      if (!v) return null;
      const vRect = rectInTop(v);
      if (!vRect) return null;
      const docs = collectDocs();
      let best = null;
      let bestTop = Infinity;
      for (let d = 0; d < docs.length; d++) {
        let nodes;
        try { nodes = docs[d].querySelectorAll('div,span,h1,h2,h3,h4,h5,p,label,strong'); } catch (e) { continue; }
        const limit = Math.min(nodes.length, 2500);
        for (let i = 0; i < limit; i++) {
          const el = nodes[i];
          let txt = '';
          try { txt = (el.textContent || '').replace(/\s+/g, ''); } catch (e) { continue; }
          if (txt !== '任务点' && !(txt.length <= 8 && txt.indexOf('任务点') === 0)) continue;
          if (!isVisible(el)) continue;
          const r = rectInTop(el);
          if (!r) continue;
          if (r.top <= vRect.top + 20) continue;
          if (r.top < bestTop) {
            bestTop = r.top;
            best = el;
          }
        }
      }
      return best;
    }

    async function feedNext() {
      const before = current;
      const mark = nextTaskMark();
      if (mark) {
        try { mark.scrollIntoView({ block: 'start', behavior: 'auto' }); } catch (e) { /* ignore */ }
        await sleep(1200);
        if (!active || !state.running || state.mode !== 'video') return false;
        const v = findVisibleVideo(before);
        if (v) {
          attach(v);
          log('已定位到下一个「任务点」并接管视频');
          return true;
        }
        log('下一个任务点中没有找到视频，停止以免反复操作', 'warn');
        setStatus('未找到下一个视频', 'warn');
        return false;
      }
      try {
        window.scrollTo(0, (window.scrollY || 0) + Math.round(window.innerHeight * 0.85));
      } catch (e) {
        try { window.scrollBy(0, Math.round(window.innerHeight * 0.85)); } catch (e2) { /* ignore */ }
      }
      await sleep(1500);
      if (!active || !state.running || state.mode !== 'video') return false;
      const v = findVisibleVideo(before);
      if (v) {
        attach(v);
        log('已向下滚动一次，找到下一个视频');
        return true;
      }
      log('未找到下一个视频（已只滚动一次，不再反复操作）', 'warn');
      setStatus('未找到下一个视频', 'warn');
      return false;
    }

    function next(reason) {
      if (!active || !state.running || state.mode !== 'video' || !cfg.autoNextVideo) return;
      if (dismissTaskDialog()) {
        schedule(1500);
        return;
      }
      const now = Date.now();
      if (now - nextLock < 3000) return;
      nextLock = now;
      log('准备播放下一个视频（' + reason + '）');
      setStatus('切换视频…', 'wait');

      if (clickNextButton()) {
        schedule(2000);
        return;
      }
      if (clickNextItem()) {
        schedule(2000);
        return;
      }
      if (!IS_TOP) {
        try { window.top.postMessage({ __cx_helper: 'next' }, '*'); } catch (e) { /* ignore */ }
        log('已请求主页面切换下一集');
        schedule(2500);
        return;
      }
      feedNext().then(function (ok) {
        if (ok) {
          schedule(1200);
        } else if (active && state.running) {
          finishRun('未找到下一个视频，已停止');
        }
      });
    }

    function start() {
      if (active) return;
      active = true;
      nextLock = 0;
      lastTick = Date.now();
      current = null;
      advanceFor = null;
      advanceAt = 0;
      lastPlayAt = 0;
      if (endTimer) {
        endTimer.clear();
        endTimer = null;
      }
      log('刷视频引擎启动');
      setStatus('准备刷视频…', 'run');
      schedule(400);
    }

    function stop() {
      active = false;
      advanceFor = null;
      advanceAt = 0;
      lastPlayAt = 0;
      if (endTimer) {
        endTimer.clear();
        endTimer = null;
      }
      if (ticker) {
        ticker.clear();
        ticker = null;
      }
      if (current) {
        try { current.pause(); } catch (e) { /* ignore */ }
      }
      current = null;
    }

    function rescan() {
      if (!active) return;
      const v = pick();
      if (v) attach(v);
      schedule(300);
    }

    function nextFromTop() {
      if (!state.running || state.mode !== 'video') return;
      if (active) {
        next('主页面请求');
        return;
      }
      /* 视频在跨域 iframe 里时，顶层自己没有 active 引擎；
         但顶层仍有“下一节”入口，收到子框架请求后替它点一次。 */
      if (!IS_TOP) return;
      log('收到子框架的切换请求，主页面尝试切换');
      if (clickNextButton() || clickNextItem()) {
        schedule(2000);
        return;
      }
      log('主页面未找到可用的“下一节”入口', 'warn');
    }

    function watchdog() {
      if (!active) return;
      if (Date.now() - lastTick > 4000) schedule(200);
    }

    return {
      start: start,
      stop: stop,
      rescan: rescan,
      nextFromTop: nextFromTop,
      watchdog: watchdog
    };
  })();

  /* ======================================================================
   * 10. 控制器：状态、主从同步、启动流程
   * ==================================================================== */

  let cfgTimer = null;

  /* v0.4：跨域播放器无法被顶层直接读取时，仍需要有人把“开始/停止”送进去。
     postMessage 可以穿过跨域边界；同源 iframe 继续向下递归，跨域 iframe 直接投递。 */
  function broadcastRun(payload) {
    const seen = [];
    function walk(doc, depth) {
      if (!doc || depth > 4) return;
      for (let i = 0; i < seen.length; i++) if (seen[i] === doc) return;
      seen.push(doc);
      let frames = [];
      try { frames = doc.querySelectorAll('iframe'); } catch (e) { return; }
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        try {
          if (f.contentWindow) f.contentWindow.postMessage(payload, '*');
        } catch (e) { /* ignore */ }
        let sub = null;
        try { sub = f.contentDocument; } catch (e) { sub = null; }
        if (sub) walk(sub, depth + 1);
      }
    }
    walk(document, 0);
  }

  function saveCfg() {
    if (cfgTimer) window.clearTimeout(cfgTimer);
    cfgTimer = window.setTimeout(function () {
      cfgTimer = null;
      gmSet(CFG_KEY, cfg);
    }, 200);
  }

  function changeMode(mode) {
    if (mode !== 'book' && mode !== 'video') return;
    cfg.mode = mode;
    saveCfg();
    if (state.running) {
      if (state.mode === mode) return;
      state.mode = mode;
      run.mode = mode;
      gmSet(RUN_KEY, run);
      log('切换为「' + (mode === 'book' ? '刷书' : '刷视频') + '」模式');
      stopEngines();
      startEngines();
    } else {
      state.mode = mode;
    }
    if (ui) ui.refresh();
  }

  /* ----------------------------------------------------------------------
   * 「自动完成作业」预留框架
   * 按需求只保留接口与流程占位，不包含任何题目解析/提交实现。
   * 后续若实现，建议在 start() 内通过题型识别 -> 答案来源 -> 填入 -> 提交
   * 的流水线扩展，并复用本文件的 Scheduler / UI / 状态同步。
   * -------------------------------------------------------------------- */
  const HomeworkEngine = {
    start: function () {
      log('「自动完成作业」仅为预留框架，尚未实现', 'warn');
      setStatus('自动作业未实现', 'warn');
    },
    stop: function () { /* 预留 */ }
  };

  function startEngines() {
    if (state.mode === 'book') {
      videoDeferred = false;
      relayEnabled = false;
      BookEngine.start();
    } else if (state.mode === 'video') {
      /* v0.4：同源子框架能直接被顶层访问时，视频只由顶层一个实例控制。
         子框架再启动一份 VideoEngine，会与顶层重复监听 ended、重复点下一集。 */
      if (!IS_TOP && topDocumentAccessible()) {
        videoDeferred = true;
        relayEnabled = false;
        log('视频由主页面统一控制，本框架不重复操作');
        setStatus('视频由主页面统一控制，本框架待命', 'wait');
        return;
      }
      videoDeferred = false;
      relayEnabled = true;
      VideoEngine.start();
    } else {
      videoDeferred = false;
      relayEnabled = false;
      HomeworkEngine.start();
    }
  }

  function stopEngines() {
    try { BookEngine.stop(); } catch (e) { /* ignore */ }
    try { VideoEngine.stop(); } catch (e) { /* ignore */ }
    try { HomeworkEngine.stop(); } catch (e) { /* ignore */ }
  }

  function startRun() {
    if (state.running) return;
    state.running = true;
    state.mode = (cfg.mode === 'video') ? 'video' : 'book';
    state.startedAt = Date.now();
    state.elapsed = 0;
    state.reloads = 0;
    state.completed = false;
    run = {
      running: true,
      mode: state.mode,
      startedAt: state.startedAt,
      reloads: 0,
      progress: 0,
      beat: Date.now(),
      url: location.href
    };
    gmSet(RUN_KEY, run);
    log('开始运行 · ' + (state.mode === 'book' ? '刷书模式' : '刷视频模式'));
    setStatus('正在启动…', 'run');
    startEngines();
    broadcastRun({ __cx_helper: 'run', run: run });
    if (ui) {
      ui.selectTab(state.mode === 'video' ? 'video' : 'book');
      ui.refresh();
      ui.tick();
    }
  }

  function stopRun(reason) {
    if (!state.running) return;
    state.elapsed = Date.now() - state.startedAt;
    state.running = false;
    stopEngines();
    run.running = false;
    run.beat = Date.now();
    gmSet(RUN_KEY, run);
    broadcastRun({ __cx_helper: 'run', run: run });
    log(reason || '已停止');
    setStatus('已停止', 'idle');
    if (ui) {
      ui.tick();
      ui.refresh();
    }
  }

  function finishRun(msg) {
    if (!state.running) return;
    state.completed = true;
    state.elapsed = Date.now() - state.startedAt;
    state.running = false;
    stopEngines();
    run.running = false;
    run.beat = Date.now();
    gmSet(RUN_KEY, run);
    broadcastRun({ __cx_helper: 'run', run: run });
    log(msg, 'ok');
    setStatus(msg, 'ok');
    if (ui) {
      ui.tick();
      ui.refresh();
    }
  }

  function heartbeat() {
    if (!IS_TOP || !state.running) return;
    const latest = gmGet(RUN_KEY, null);
    const base = (latest && typeof latest === 'object') ? latest : run;
    base.running = true;
    base.mode = state.mode;
    base.startedAt = state.startedAt;
    base.beat = Date.now();
    base.reloads = state.reloads;
    base.url = location.href;
    run = base;
    gmSet(RUN_KEY, base);
  }

  let applyingRemote = false;

  function applyCfg(next) {
    if (!next || typeof next !== 'object') return;
    Object.keys(DEFAULTS).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(next, k)) cfg[k] = next[k];
    });
    if (ui) ui.refresh();
  }

  function applyRun(next) {
    if (!next || typeof next !== 'object' || applyingRemote) return;
    applyingRemote = true;
    try {
      const wasRunning = state.running;
      run = next;
      if (next.running && !wasRunning) {
        state.running = true;
        state.mode = (next.mode === 'video') ? 'video' : 'book';
        state.startedAt = Number(next.startedAt) || Date.now();
        state.reloads = Number(next.reloads) || 0;
        state.completed = false;
        if (ui) ui.refresh();
        setStatus('正在启动…', 'run');
        log('已同步主页面任务，开始运行');
        startEngines();
      } else if (!next.running && wasRunning) {
        state.elapsed = Date.now() - state.startedAt;
        state.running = false;
        stopEngines();
        setStatus('已停止', 'idle');
        if (ui) {
          ui.tick();
          ui.refresh();
        }
      } else if (next.running && wasRunning && next.mode && next.mode !== state.mode) {
        state.mode = next.mode;
        stopEngines();
        startEngines();
        if (ui) ui.refresh();
      }
    } finally {
      applyingRemote = false;
    }
  }

  function setupRemote() {
    if (typeof GM_addValueChangeListener === 'function') {
      try {
        GM_addValueChangeListener(CFG_KEY, function (name, oldVal, newVal, remote) {
          if (remote && newVal) applyCfg(newVal);
        });
        GM_addValueChangeListener(RUN_KEY, function (name, oldVal, newVal, remote) {
          if (remote && newVal) applyRun(newVal);
        });
      } catch (e) { /* ignore */ }
    }
    Scheduler.every(2000, function () {
      if (IS_TOP) return;
      const latest = gmGet(RUN_KEY, null);
      if (latest && typeof latest === 'object' && !!latest.running !== !!state.running) {
        applyRun(latest);
      }
    });
  }

  function resumeFromStorage() {
    if (!run || !run.running) return;
    const stale = !run.beat || (Date.now() - Number(run.beat) > 15 * 60 * 1000);
    if (!cfg.autoResume || stale) {
      run.running = false;
      run.beat = Date.now();
      gmSet(RUN_KEY, run);
      if (stale) log('上次任务已超过 15 分钟，未自动恢复', 'warn');
      return;
    }
    state.running = true;
    state.mode = (run.mode === 'video') ? 'video' : 'book';
    state.startedAt = Number(run.startedAt) || Date.now();
    state.reloads = Number(run.reloads) || 0;
    setStatus('自动恢复中…', 'run');
    log('检测到未完成的任务，准备自动恢复');
    if (ui) {
      ui.selectTab(state.mode === 'video' ? 'video' : 'book');
      ui.refresh();
    }
    Scheduler.after(1500, function () {
      if (!state.running) return;
      startEngines();
      if (IS_TOP) broadcastRun({ __cx_helper: 'run', run: run });
    });
  }

  function registerHotkeys() {
    document.addEventListener('keydown', function (e) {
      if (e.altKey && e.shiftKey && (e.code === 'KeyC' || e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
      }
    }, true);
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('显示 / 隐藏控制面板', function () { togglePanel(); });
      GM_registerMenuCommand('开始 / 停止刷时长', function () {
        if (state.running) stopRun('菜单停止');
        else startRun();
      });
    } catch (e) { /* ignore */ }
  }

  function boot() {
    if (!IS_TOP) {
      try { document.documentElement.setAttribute('data-cx-helper', '1'); } catch (e) { /* ignore */ }
      /* 子框架若在顶层“开始”之后才加载，会错过那一次广播；主动向顶层索取当前任务。 */
      try { window.top.postMessage({ __cx_helper: 'hello' }, '*'); } catch (e) { /* ignore */ }
    }
    if (IS_TOP) {
      createUI();
      registerHotkeys();
      registerMenu();
    }
    setupRemote();
    resumeFromStorage();

    Scheduler.every(500, function () {
      if (IS_TOP && ui && state.running) ui.tick();
    });
    Scheduler.every(10000, heartbeat);
    Scheduler.every(5000, function () {
      if (!state.running) return;
      if (state.mode === 'book') BookEngine.watchdog();
      else if (state.mode === 'video') VideoEngine.watchdog();
    });

    if (!state.running) setStatus('未启动', 'idle');
  }

  /* ---------- 启动 ---------- */

  window.addEventListener('message', function (e) {
    const data = e && e.data;
    if (!data || !data.__cx_helper) return;

    /* 子框架晚于“开始”加载时，主动向顶层要一份 run 状态。 */
    if (data.__cx_helper === 'hello') {
      if (!IS_TOP || !state.running || state.mode !== 'video') return;
      try {
        if (e.source) e.source.postMessage({ __cx_helper: 'run', run: run }, '*');
      } catch (err) { /* ignore */ }
      return;
    }

    /* 跨域子框架收不到顶层 localStorage 里的运行状态，用 postMessage 补一份；
       收到后继续向自己的子框架转发，直到播放器那一层。 */
    if (data.__cx_helper === 'run') {
      if (IS_TOP) return;
      if (!data.run || typeof data.run !== 'object') return;
      applyRun(data.run);
      broadcastRun(data);
      return;
    }

    /* 跨域 iframe 无法被顶层直接控制时，子框架把进度/日志/切换请求转发上来。 */
    if (data.__cx_helper === 'status') {
      if (!IS_TOP || !state.running || state.mode !== 'video') return;
      lastChildStatusAt = Date.now();
      if (typeof data.text === 'string') setStatus(data.text, data.level || 'run');
      return;
    }
    if (data.__cx_helper === 'log') {
      if (!IS_TOP || !state.running || state.mode !== 'video') return;
      if (typeof data.msg === 'string') log(data.msg, data.level || 'info');
      return;
    }
    if (data.__cx_helper === 'next') {
      if (!state.running || state.mode !== 'video') return;
      VideoEngine.nextFromTop();
    }
  }, false);

  window.addEventListener('pagehide', function () {
    if (!IS_TOP) return;
    if (cfgTimer) {
      cfgTimer = null;
      gmSet(CFG_KEY, cfg);
    }
  }, false);

  installVisibilitySpoof();
  hookSpa();
  onReady(boot);
})();
