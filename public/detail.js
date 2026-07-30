/* ===== 访问明细（独立页 detail.html 的逻辑，单一源，mode 驱动差异）===== */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var API = '/api/ss', PAGE_SIZE = 30;
  var params = new URLSearchParams(location.search);
  var MODE = params.get('mode') === 'range' ? 'range' : 'today';
  var state = { mode: MODE, all: [], filtered: [], sortK: 't', sortDir: -1, page: 1, search: '', dev: '', co: '', from: '', to: '' };
  var DEV_COLOR = { desktop: '#0c5c48', mobile: '#e8a70e', tablet: '#2f6db3' };
  var DEV_NAME = { desktop: '桌面', mobile: '移动', tablet: '平板' };
  var FRESH_MS = 5 * 60 * 1000;

  function token() { return sessionStorage.getItem('ss_token') || ''; }
  function todayKey() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function dash(v) { return v ? esc(v) : '<span style="color:var(--ink3)">—</span>'; }
  function fmtTime(t) { var d = new Date(t), p = function (n) { return String(n).padStart(2, '0'); }; return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function fmtStay(s) { if (!s) return '—'; return s >= 60 ? Math.floor(s / 60) + '分' + (s % 60 ? s % 60 + '秒' : '') : s + '秒'; }
  function toast(msg) { var t = $('#toast'); if (!t) return; t.textContent = msg; t.classList.add('on'); clearTimeout(t._tt); t._tt = setTimeout(function () { t.classList.remove('on'); }, 1800); }
  function goLogin() { location.replace('/ss-admin.html'); }

  function showNotice(kind, msg) {
    var n = $('#dNotice'); if (!n) return;
    n.hidden = false; n.className = 'd-notice ' + kind;
    n.innerHTML = msg + (kind === 'err' ? ' <button class="d-retry" id="dRetry">重新加载</button>' : "");
    if (kind === 'err') { var b = $('#dRetry'); if (b) b.onclick = function () { open(state.mode); }; }
  }
  function hideNotice() { var n = $('#dNotice'); if (n) { n.hidden = true; n.innerHTML = ""; } }

  function daysSpan() {
    var ds = {}; state.filtered.forEach(function (r) { ds[r.d] = 1; });
    return Math.max(1, Object.keys(ds).length);
  }
  function renderScope() {
    var el = $('#dScope'); if (!el) return;
    var n = state.filtered.length, tot = (state.all || []).length;
    var txt;
    if (state.mode === 'today') txt = '当日 ' + todayKey() + ' · ' + n + ' 条';
    else if (state.from || state.to) txt = '自定义 ' + (state.from || '…') + ' ~ ' + (state.to || '…') + ' · ' + n + ' 条';
    else txt = '全部 · ' + n + ' 条（库内共 ' + tot + ' 条）';
    if (state.search || state.dev || state.co) txt += ' · 已筛选';
    el.textContent = txt;
  }

  function fetchVisits(cb) {
    $('#dBody').innerHTML = '<tr><td colspan="11"><div class="d-loading"><span class="d-spin"></span>正在加载明细…</div></td></tr>';
    fetch(API + '/visits?token=' + encodeURIComponent(token())).then(function (r) {
      if (r.status === 401) { goLogin(); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      if (!Array.isArray(d)) return;
      hideNotice(); cb(d);
    }).catch(function (e) {
      showNotice('err', '加载失败（' + (e && e.message ? e.message : '网络异常') + '）——下方保留上一次成功的数据。');
      if (!state.all || !state.all.length) $('#dBody').innerHTML = '<tr><td colspan="11"><div class="d-empty">未能加载数据，请检查网络后点上方「重新加载」。</div></td></tr>';
    });
  }

  function open(mode) {
    state.mode = mode; state.page = 1; state.search = ""; state.dev = ""; state.co = ""; state.from = ""; state.to = "";
    $('#dSearch').value = ""; $('#dDev').value = ""; $('#dCo').value = ""; $('#dFrom').value = ""; $('#dTo').value = "";
    $('#dMode').textContent = mode === 'today' ? '当日' : '历史';
    $('#dRangeWrap').style.display = mode === 'today' ? 'none' : 'inline-flex';
    var badge = $('#mBadge');
    if (badge) badge.className = 'm-badge ' + (mode === 'today' ? 'live' : 'calm');
    $('#dTip').textContent = mode === 'today'
      ? '今日（' + todayKey() + '）每一条访问的完整记录；点任意一行可展开 User-Agent 等详情，点 IP 可复制。'
      : '全部访问记录，可用日期 / 设备 / 地域 / 关键词筛选；点表头可排序。';
    $('#dBody').innerHTML = '<tr><td colspan="11"><div class="d-loading">正在加载明细…</div></td></tr>';
    fetchVisits(function (list) { state.all = list; fillFilters(); apply(); paintCalmBadge(); window.scrollTo(0, 0); });
  }
  function paintCalmBadge() {
    var b = $('#mBadge'); if (!b || state.mode !== 'range') return;
    b.textContent = '▦ 全景 · 覆盖 ' + daysSpan() + ' 天';
  }

  function inRange(r) {
    if (state.mode === 'today') return r.d === todayKey();
    if (state.from && r.d < state.from) return false;
    if (state.to && r.d > state.to) return false;
    return true;
  }
  function fillFilters() {
    var devs = {}, cos = {};
    (state.all || []).forEach(function (r) { if (inRange(r)) { if (r.dev) devs[r.dev] = 1; cos[r.co || '未知'] = 1; } });
    $('#dDev').innerHTML = '<option value="">全部设备</option>' + Object.keys(devs).map(function (k) { return '<option value="' + k + '">' + (DEV_NAME[k] || k) + '</option>'; }).join("");
    $('#dCo').innerHTML = '<option value="">全部地域</option>' + Object.keys(cos).sort().map(function (k) { return '<option value="' + k + '">' + esc(k) + '</option>'; }).join("");
  }
  function apply() {
    var kw = state.search.trim().toLowerCase();
    state.filtered = (state.all || []).filter(inRange).filter(function (r) {
      if (state.dev && r.dev !== state.dev) return false;
      if (state.co && (r.co || '未知') !== state.co) return false;
      if (kw) { var hay = [r.ip, r.p, r.co, r.rg, r.city, r.ua, r.os, r.browser, r.sl, r.lang].join(' ').toLowerCase(); if (hay.indexOf(kw) < 0) return false; }
      return true;
    });
    var k = state.sortK, dir = state.sortDir;
    state.filtered.sort(function (a, b) { var x = a[k], y = b[k]; if (x == null) x = ""; if (y == null) y = ""; if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir; return String(x).localeCompare(String(y)) * dir; });
    state.page = Math.min(state.page, Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE)));
    renderStats(); renderDist(); renderTable(); renderPager(); renderScope(); paintCalmBadge();
  }

  function renderStats() {
    var rows = state.filtered, uv = {}, ips = {}, cos = {}, stays = [], mob = 0;
    rows.forEach(function (r) { uv[r.uid] = 1; if (r.ip) ips[r.ip] = 1; cos[(r.co || '未知') + (r.rg || "")] = 1; if (r.stay > 1 && r.stay < 1800) stays.push(r.stay); if (r.dev === 'mobile') mob++; });
    var avg = stays.length ? Math.round(stays.reduce(function (a, b) { return a + b; }, 0) / stays.length) : 0;
    var days = daysSpan(), tot = (state.all || []).length;
    var subT = ['今日累计 · 实时', '独立访客 · 实时', '此刻分布', '实时覆盖', '今日均值', '今日占比'];
    var subR = ['日均 ' + Math.round(rows.length / days), '占 IP ' + (Object.keys(ips).length ? Math.round(Object.keys(uv).length / Object.keys(ips).length * 100) : 0) + '%', '去重地址', '覆盖 ' + Object.keys(cos).length + ' 区', '区间均值', '区间占比'];
    var sub = state.mode === 'today' ? subT : subR;
    var live = state.mode === 'today';
    var cards = [['浏览量 PV', rows.length, sub[0], live], ['独立访客 UV', Object.keys(uv).length, sub[1], live], ['独立 IP', Object.keys(ips).length, sub[2], false], ['国家/地区', Object.keys(cos).length, sub[3], false], ['平均停留', fmtStay(avg), sub[4], false], ['移动端占比', rows.length ? Math.round(mob / rows.length * 100) + '%' : '0%', sub[5], false]];
    $('#dStats').innerHTML = cards.map(function (c) {
      return '<div class="d-stat' + (c[3] ? ' live' : "") + '"><div class="l">' + c[0] + '</div><div class="v">' + c[1] + '</div><div class="sub">' + c[2] + '</div></div>';
    }).join("");
  }
  function topBy(key, n) { var m = {}; state.filtered.forEach(function (r) { var k = r[key] || '未知'; m[k] = (m[k] || 0) + 1; }); return Object.keys(m).map(function (k) { return { l: k, v: m[k] }; }).sort(function (a, b) { return b.v - a.v; }).slice(0, n || 5); }
  function dist(items, color) {
    if (!items.length) return '<div style="color:var(--ink3);font-size:12px">暂无数据</div>';
    var max = items[0].v || 1;
    return items.map(function (it) { return '<div class="dbar"><span class="n" title="' + esc(it.l) + '">' + esc(it.l) + '</span><span class="t"><i style="background:' + color + '" data-w="' + (it.v / max * 100).toFixed(1) + '%"></i></span><span class="c">' + it.v + '</span></div>'; }).join("");
  }
  function miniBars(vals, color, labels) {
    var max = Math.max(1, Math.max.apply(null, vals));
    return '<div class="mini">' + vals.map(function (v, i) { return '<i style="height:' + Math.max(3, v / max * 100).toFixed(0) + '%;background:' + color + '" title="' + (labels ? labels[i] : i) + ' · ' + v + '"></i>'; }).join("") + '</div>';
  }
  function hour24(rows) { var a = new Array(24).fill(0); rows.forEach(function (r) { a[new Date(r.t).getHours()]++; }); return a; }
  function dailyPV(rows) { var m = {}; rows.forEach(function (r) { m[r.d] = (m[r.d] || 0) + 1; }); var ks = Object.keys(m).sort(); return { v: ks.map(function (k) { return m[k]; }), l: ks.map(function (k) { return k.slice(5); }) }; }
  function renderDist() {
    var fifth = state.mode === 'today'
      ? '<div class="panel"><h4>活跃时段</h4>' + miniBars(hour24(state.filtered), '#e8a70e') + '<div class="mini-axis"><span>0</span><span>12</span><span>23</span></div></div>'
      : (function () { var d = dailyPV(state.filtered); return '<div class="panel"><h4>每日趋势</h4>' + miniBars(d.v, '#0c5c48', d.l) + '<div class="mini-axis"><span>' + (d.l[0] || "") + '</span><span>' + (d.l[d.l.length - 1] || "") + '</span></div></div>'; })();
    $('#dDist').innerHTML =
      '<div class="panel"><h4>设备</h4>' + dist(topBy('dev', 4).map(function (x) { x.l = DEV_NAME[x.l] || x.l; return x; }), '#0c5c48') + '</div>' +
      '<div class="panel"><h4>操作系统</h4>' + dist(topBy('os', 5), '#2f6db3') + '</div>' +
      '<div class="panel"><h4>浏览器</h4>' + dist(topBy('browser', 5), '#e8a70e') + '</div>' +
      '<div class="panel"><h4>国家/地区</h4>' + dist(topBy('co', 5), '#c4472f') + '</div>' + fifth;
    requestAnimationFrame(function () { requestAnimationFrame(function () { document.querySelectorAll('#dDist .t i').forEach(function (i) { i.style.width = i.dataset.w; }); }); });
  }
  function renderTable() {
    var body = $('#dBody');
    if (!state.filtered.length) { body.innerHTML = '<tr><td colspan="11"><div class="d-empty">没有符合条件的访问记录。</div></td></tr>'; return; }
    var start = (state.page - 1) * PAGE_SIZE, now = Date.now(), live = state.mode === 'today';
    var rows = state.filtered.slice(start, start + PAGE_SIZE);
    body.innerHTML = rows.map(function (r, i) {
      var fresh = live && (now - r.t) < FRESH_MS;
      var geo = '<span class="geo"><b>' + esc(r.co || '未知') + '</b>' + (r.rg ? ' <span>' + esc(r.rg) + '</span>' : "") + (r.city ? ' <span>· ' + esc(r.city) + '</span>' : "") + '</span>';
      return '<tr class="row' + (fresh ? ' fresh' : "") + '" data-i="' + (start + i) + '">' +
        '<td><span class="caret">▶</span></td>' +
        '<td class="mono">' + (fresh ? '<span class="newdot"></span>' : "") + fmtTime(r.t) + '</td>' +
        '<td class="ip" data-ip="' + esc(r.ip || "") + '" title="点击复制">' + dash(r.ip) + '</td>' +
        '<td>' + geo + '</td>' +
        '<td class="pg" title="' + esc(r.p) + '">' + esc(r.p || '/') + '</td>' +
        '<td><span class="devdot" style="background:' + (DEV_COLOR[r.dev] || '#999') + '"></span>' + (DEV_NAME[r.dev] || r.dev || '—') + '</td>' +
        '<td>' + dash(r.os) + '</td>' +
        '<td>' + dash(r.browser) + '</td>' +
        '<td class="mono">' + dash(r.scr) + '</td>' +
        '<td title="' + esc(r.sl || "") + '">' + dash(r.sl) + '</td>' +
        '<td class="stay">' + fmtStay(r.stay) + '</td>' +
        '</tr>';
    }).join("");
  }
  function renderPager() {
    var total = state.filtered.length, pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    $('#dCount').textContent = '共 ' + total + ' 条记录';
    $('#dPage').textContent = '第 ' + state.page + ' / ' + pages + ' 页';
    $('#dPrev').disabled = state.page <= 1;
    $('#dNext').disabled = state.page >= pages;
  }
  function detailRowHtml(r) {
    var items = [['完整时间', new Date(r.t).toLocaleString()], ['访客 ID', r.uid || '—'], ['会话 ID', r.sid || '—'], ['来源类型', r.st || '—'], ['语言', r.lang || '—'], ['时区', r.tz || '—'], ['屏幕', r.scr || '—'], ['IP 地址', r.ip || '（未记录）'], ['User-Agent', r.ua || '（未记录）']];
    return '<tr class="detail-row"><td colspan="11"><div class="inner">' + items.map(function (kv) { return '<div class="kv"><b>' + kv[0] + '</b><span>' + esc(kv[1]) + '</span></div>'; }).join("") + '</div></td></tr>';
  }

  $('#dReset').addEventListener('click', function () { open(state.mode); });
  $('#dPrev').addEventListener('click', function () { if (state.page > 1) { state.page--; renderTable(); renderPager(); } });
  $('#dNext').addEventListener('click', function () { var pages = Math.ceil(state.filtered.length / PAGE_SIZE); if (state.page < pages) { state.page++; renderTable(); renderPager(); } });
  var st;
  $('#dSearch').addEventListener('input', function () { var v = this.value; clearTimeout(st); st = setTimeout(function () { state.search = v; state.page = 1; apply(); }, 250); });
  $('#dDev').addEventListener('change', function () { state.dev = this.value; state.page = 1; apply(); });
  $('#dCo').addEventListener('change', function () { state.co = this.value; state.page = 1; apply(); });
  $('#dFrom').addEventListener('change', function () { state.from = this.value; state.page = 1; apply(); });
  $('#dTo').addEventListener('change', function () { state.to = this.value; state.page = 1; apply(); });
  document.querySelectorAll('.dtable th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = this.dataset.k;
      if (state.sortK === k) state.sortDir *= -1; else { state.sortK = k; state.sortDir = (k === 't' ? -1 : 1); }
      document.querySelectorAll('.dtable th').forEach(function (x) { x.classList.remove('sorted'); var a = x.querySelector('.arr'); if (a) a.textContent = '▼'; });
      this.classList.add('sorted'); var arr = this.querySelector('.arr'); if (arr) arr.textContent = state.sortDir > 0 ? '▲' : '▼';
      apply();
    });
  });
  $('#dBody').addEventListener('click', function (e) {
    var ip = e.target.closest('.ip');
    if (ip && ip.dataset.ip) { var val = ip.dataset.ip; if (navigator.clipboard) navigator.clipboard.writeText(val).then(function () { toast('已复制 IP：' + val); }); return; }
    var row = e.target.closest('tr.row'); if (!row) return;
    var isOpen = row.classList.contains('open'), nxt = row.nextElementSibling;
    if (nxt && nxt.classList.contains('detail-row')) nxt.remove();
    row.classList.remove('open'); if (isOpen) return;
    var r = state.filtered[+row.dataset.i]; if (!r) return;
    row.classList.add('open'); row.insertAdjacentHTML('afterend', detailRowHtml(r));
  });
  $('#dExport').addEventListener('click', function () {
    if (!state.filtered.length) { toast('没有可导出的数据'); return; }
    var head = '时间,IP,国家,地区,城市,页面,设备,系统,浏览器,屏幕,来源类型,来源,语言,时区,停留秒,访客ID,会话ID,User-Agent\n';
    var body = state.filtered.map(function (r) {
      return [new Date(r.t).toLocaleString(), r.ip || "", r.co || "", r.rg || "", r.city || "", r.p || "", r.dev || "", r.os || "", r.browser || "", r.scr || "", r.st || "", r.sl || "", r.lang || "", r.tz || "", r.stay || 0, r.uid || "", r.sid || "", r.ua || ""]
        .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + head + body], { type: 'text/csv' }));
    a.download = 'visit-detail-' + (state.mode === 'today' ? todayKey() : 'all') + '.csv';
    a.click(); URL.revokeObjectURL(a.href);
    toast('已导出 ' + state.filtered.length + ' 条');
  });
  var out = $('#dOut'); if (out) out.addEventListener('click', function () { sessionStorage.removeItem('ss_token'); goLogin(); });

  fetch('/api/ss/version').then(function (r) { return r.json(); }).then(function (d) {
    var b = $('#verBadge'); if (b && d && d.version) { b.textContent = 'v' + d.version; b.title = (d.name || 'SiteStats') + ' · 版本单一源 package.json'; }
  }).catch(function () {});

  if (!token()) { goLogin(); return; }
  open(MODE);
})();
