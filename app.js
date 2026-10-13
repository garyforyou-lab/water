(function () {
  "use strict";
  var CFG = window.HYDRO_CONFIG || {};
  var LS_PREFIX = "hydrotrack_v4_";
  var sb = null, user = null;
  var state = { goal: 2000, logs: {}, queue: [] };   // logs: id -> {id, ts, ml}   queue: pending ops not yet in the cloud
  var tab = "today", curKey = "", signUpMode = false, flushing = false;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- date helpers (local time) ---------- */
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function dayKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function keyOfTs(ts) { return dayKey(new Date(ts)); }
  function fmt(n) { return Math.round(n).toLocaleString("en-US"); }
  function timeOf(ts) { return new Date(ts).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false }); }
  function daysBack(n) { var out = []; for (var i = n - 1; i >= 0; i--) { var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i); out.push(d); } return out; }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); });
  }

  /* ---------- local cache, one per signed-in person ---------- */
  function lsKey() { return LS_PREFIX + (user ? user.id : "anon"); }
  function saveLocal() { try { localStorage.setItem(lsKey(), JSON.stringify(state)); } catch (e) {} }
  function loadLocal() {
    state = { goal: 2000, logs: {}, queue: [] };
    try {
      var r = JSON.parse(localStorage.getItem(lsKey()) || "null");
      if (r && typeof r === "object") {
        if (typeof r.goal === "number" && r.goal >= 100) state.goal = r.goal;
        if (r.logs) state.logs = r.logs;
        if (Array.isArray(r.queue)) state.queue = r.queue;
      }
    } catch (e) {}
  }

  /* ---------- view of data = server logs + pending adds - pending deletes ---------- */
  function viewLogs() {
    var m = {};
    Object.keys(state.logs).forEach(function (id) { m[id] = state.logs[id]; });
    state.queue.forEach(function (op) {
      if (op.t === "add") m[op.log.id] = op.log;
      else if (op.t === "del") delete m[op.id];
    });
    return m;
  }
  function totals() {
    var t = {}, m = viewLogs();
    Object.keys(m).forEach(function (id) { var l = m[id]; var k = keyOfTs(l.ts); t[k] = (t[k] || 0) + l.ml; });
    return t;
  }

  /* ---------- sync ---------- */
  function setChip(s, txt) { $("chip").setAttribute("data-s", s); $("chip-t").textContent = txt; }
  function refreshChip() {
    if (!navigator.onLine) return setChip("wait", state.queue.length ? "離線，" + state.queue.length + " 筆待上傳" : "離線");
    if (state.queue.length) return setChip("wait", state.queue.length + " 筆待上傳");
    setChip("ok", "已同步");
  }
  async function flush() {
    if (!sb || !user || flushing || !navigator.onLine) return;
    flushing = true;
    try {
      while (state.queue.length) {
        var op = state.queue[0], res;
        if (op.t === "add") res = await sb.from("drink_logs").upsert({ id: op.log.id, user_id: user.id, ml: op.log.ml, ts: new Date(op.log.ts).toISOString() }, { onConflict: "id" });
        else if (op.t === "del") res = await sb.from("drink_logs").delete().eq("id", op.id);
        else if (op.t === "goal") res = await sb.from("drink_settings").upsert({ user_id: user.id, goal: op.goal }, { onConflict: "user_id" });
        else { state.queue.shift(); continue; }
        if (res.error) { if (res.error.code && String(res.error.code).indexOf("PGRST3") === 0 || res.status === 401) break; if (res.status >= 400 && res.status < 500) { state.queue.shift(); continue; } break; }
        state.queue.shift(); saveLocal();
      }
    } catch (e) {}
    flushing = false;
    refreshChip();
  }
  async function pull() {
    if (!sb || !user || !navigator.onLine) return;
    try {
      var since = new Date(); since.setDate(since.getDate() - 400);
      var a = await sb.from("drink_logs").select("id,ml,ts").gte("ts", since.toISOString()).order("ts", { ascending: true }).limit(20000);
      var b = await sb.from("drink_settings").select("goal").maybeSingle();
      if (a.error) { setChip("wait", "同步失敗"); return; }
      var logs = {};
      a.data.forEach(function (r) { logs[r.id] = { id: r.id, ml: r.ml, ts: new Date(r.ts).getTime() }; });
      state.logs = logs;
      if (b && b.data && typeof b.data.goal === "number") state.goal = b.data.goal;
      saveLocal(); render(); refreshChip();
    } catch (e) { setChip("wait", "同步失敗"); }
  }
  async function syncAll() { await flush(); await pull(); await flush(); }

  /* ---------- actions ---------- */
  function addLog(ml) {
    ml = Math.round(ml);
    if (!(ml > 0 && ml <= 3000)) { toast("請輸入 1 到 3000 之間的毫升數"); return; }
    var before = totals()[dayKey(new Date())] || 0;
    var log = { id: uuid(), ts: Date.now(), ml: ml };
    state.queue.push({ t: "add", log: log });
    saveLocal(); render(); beep(); refreshChip();
    var after = before + ml;
    if (before < state.goal && after >= state.goal) { confetti(); toast("達標了！今天已喝 " + fmt(after) + " ml"); }
    else toast("已加入 " + fmt(ml) + " ml");
    flush();
  }
  function removeLog(id) {
    var pendingAdd = state.queue.findIndex(function (op) { return op.t === "add" && op.log.id === id; });
    if (pendingAdd >= 0) state.queue.splice(pendingAdd, 1);   // never reached the cloud
    else { delete state.logs[id]; state.queue.push({ t: "del", id: id }); }
    saveLocal(); render(); refreshChip(); toast("已刪除"); flush();
  }
  function saveGoal() {
    var g = parseInt($("goal").value, 10);
    if (!(g >= 500 && g <= 10000)) { toast("目標請設在 500 到 10000 ml"); return; }
    state.goal = g;
    state.queue = state.queue.filter(function (op) { return op.t !== "goal"; });
    state.queue.push({ t: "goal", goal: g });
    saveLocal(); render(); refreshChip(); toast("目標已更新為 " + fmt(g) + " ml"); flush();
  }

  /* ---------- rendering ---------- */
  function streakCount(t) {
    var n = 0, d = new Date(); d.setHours(12, 0, 0, 0);
    if ((t[dayKey(d)] || 0) < state.goal) d.setDate(d.getDate() - 1);
    while ((t[dayKey(d)] || 0) >= state.goal && n < 3650) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function renderToday(t) {
    var key = dayKey(new Date()), total = t[key] || 0, goal = state.goal, pct = total / goal * 100;
    $("today-ml").textContent = fmt(total);
    $("today-sub").textContent = "目標 " + fmt(goal) + " ml · " + Math.round(pct) + "%";
    $("remain").textContent = fmt(Math.max(goal - total, 0)) + " ml";
    $("streak").textContent = streakCount(t) + " 天";
    var fill = Math.min(pct, 100);
    $("lvl-front").style.transform = "translateY(" + (fill <= 0 ? 205 : 199 - fill * 1.9) + "px)";
    $("lvl-back").style.transform = "translateY(" + (fill <= 0 ? 205 : 193 - fill * 1.9) + "px)";
    var m = viewLogs();
    var rows = Object.keys(m).map(function (id) { return m[id]; }).filter(function (l) { return keyOfTs(l.ts) === key; }).sort(function (a, b) { return b.ts - a.ts; });
    $("log-count").textContent = rows.length + " 筆";
    var box = $("log"); box.textContent = "";
    if (!rows.length) { var p = document.createElement("p"); p.className = "empty"; p.textContent = "今天還沒有紀錄。點上方的杯量，喝一口記一筆。"; box.appendChild(p); return; }
    rows.forEach(function (l) {
      var row = document.createElement("div"); row.className = "row";
      var left = document.createElement("div");
      var a = document.createElement("span"); a.className = "amt"; a.textContent = "+" + fmt(l.ml) + " ml";
      var tm = document.createElement("span"); tm.className = "tm"; tm.textContent = timeOf(l.ts);
      left.appendChild(a); left.appendChild(tm);
      var del = document.createElement("button"); del.className = "del"; del.type = "button"; del.textContent = "刪除";
      del.setAttribute("aria-label", "刪除 " + timeOf(l.ts) + " 的 " + l.ml + " ml");
      var timer = null;
      del.addEventListener("click", function () {
        if (del.getAttribute("data-armed") === "1") { clearTimeout(timer); removeLog(l.id); return; }
        del.setAttribute("data-armed", "1"); del.textContent = "確定刪除？";
        timer = setTimeout(function () { del.removeAttribute("data-armed"); del.textContent = "刪除"; }, 3000);
      });
      row.appendChild(left); row.appendChild(del); box.appendChild(row);
    });
  }
  function chart(days, t, withVals) {
    var W = 340, H = 180, L = 40, R = 8, T = 16, B = 24;
    var vals = days.map(function (d) { return t[dayKey(d)] || 0; });
    var goal = state.goal, max = Math.max(goal * 1.15, Math.max.apply(null, vals) * 1.08);
    var iw = W - L - R, ih = H - T - B, n = days.length, step = iw / n, bw = Math.max(step * 0.66, 3);
    function Y(v) { return T + ih - v / max * ih; }
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="飲水量長條圖"><g class="axis">';
    s += '<line class="base" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(0) + '" y2="' + Y(0) + '"/>';
    s += '<text x="' + (L - 6) + '" y="' + (Y(0) + 3) + '" text-anchor="end">0</text>';
    s += '<line class="goal" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(goal) + '" y2="' + Y(goal) + '"/>';
    s += '<text x="' + (L - 6) + '" y="' + (Y(goal) + 3) + '" text-anchor="end">' + fmt(goal) + "</text>";
    vals.forEach(function (v, i) {
      var x = L + i * step + (step - bw) / 2, h = v / max * ih;
      s += '<rect class="bar' + (v >= goal ? " hit" : "") + '" x="' + x.toFixed(1) + '" y="' + (Y(0) - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(h, v > 0 ? 1 : 0).toFixed(1) + '" rx="3"/>';
      if (withVals && v > 0) s += '<text class="val" x="' + (x + bw / 2).toFixed(1) + '" y="' + (Y(v) - 4).toFixed(1) + '" text-anchor="middle">' + (v / 1000).toFixed(1) + "</text>";
      var every = n > 10 ? 5 : 1;
      if ((n - 1 - i) % every === 0) {
        var lab = n > 10 ? (days[i].getMonth() + 1) + "/" + days[i].getDate() : ["日", "一", "二", "三", "四", "五", "六"][days[i].getDay()];
        s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 7) + '" text-anchor="middle">' + lab + "</text>";
      }
    });
    return s + "</g></svg>";
  }
  function renderRange(t) {
    var w = daysBack(7), m = daysBack(30);
    var wv = w.map(function (d) { return t[dayKey(d)] || 0; }), mv = m.map(function (d) { return t[dayKey(d)] || 0; });
    var sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
    var hit = function (a) { return a.filter(function (v) { return v >= state.goal; }).length; };
    $("w-total").textContent = (sum(wv) / 1000).toFixed(1) + " L";
    $("w-avg").textContent = fmt(sum(wv) / 7) + " ml";
    $("w-hit").textContent = hit(wv) + " / 7";
    $("m-total").textContent = (sum(mv) / 1000).toFixed(1) + " L";
    $("m-hit").textContent = hit(mv) + " / 30";
    $("m-max").textContent = fmt(Math.max.apply(null, mv)) + " ml";
    $("w-chart").innerHTML = chart(w, t, true);
    $("m-chart").innerHTML = chart(m, t, false);
  }
  function render() {
    curKey = dayKey(new Date());
    $("date").textContent = new Date().toLocaleDateString("zh-TW", { month: "long", day: "numeric", weekday: "long" });
    var t = totals(); renderToday(t); renderRange(t);
  }

  /* ---------- effects ---------- */
  var tt = null;
  function toast(msg) { var el = $("toast"); el.textContent = msg; el.classList.add("on"); clearTimeout(tt); tt = setTimeout(function () { el.classList.remove("on"); }, 2200); }
  var actx = null;
  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      actx = actx || new AC(); var o = actx.createOscillator(), g = actx.createGain(), n = actx.currentTime;
      o.type = "sine"; o.frequency.setValueAtTime(450, n); o.frequency.exponentialRampToValueAtTime(900, n + .12);
      g.gain.setValueAtTime(.12, n); g.gain.exponentialRampToValueAtTime(.001, n + .14);
      o.connect(g); g.connect(actx.destination); o.start(n); o.stop(n + .15);
    } catch (e) {}
  }
  function confetti() {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var c = $("fx"), x = c.getContext("2d"); c.width = innerWidth; c.height = innerHeight;
    var cols = ["#1C9BBE", "#8FD3E6", "#4FCB94", "#E0A84A", "#E6F1F3"];
    var ps = []; for (var i = 0; i < 70; i++) ps.push({ x: innerWidth / 2, y: innerHeight * .45, vx: (Math.random() - .5) * 9, vy: -Math.random() * 9 - 2, s: Math.random() * 6 + 3, c: cols[i % cols.length] });
    var f = 0;
    (function tick() {
      x.clearRect(0, 0, c.width, c.height);
      ps.forEach(function (p) { p.vy += .28; p.x += p.vx; p.y += p.vy; x.fillStyle = p.c; x.fillRect(p.x, p.y, p.s, p.s * .6); });
      if (++f < 90) requestAnimationFrame(tick); else x.clearRect(0, 0, c.width, c.height);
    })();
  }

  /* ---------- auth ---------- */
  function showAuth() { $("main").hidden = true; $("auth").hidden = false; }
  function showMain() { $("auth").hidden = true; $("main").hidden = false; }
  function authMsg(text, kind) { var m = $("auth-msg"); if (!text) { m.hidden = true; return; } m.hidden = false; m.className = "msg" + (kind ? " " + kind : ""); m.textContent = text; }
  function explain(err) {
    var m = (err && err.message) || "";
    if (/invalid login/i.test(m)) return "Email 或密碼不對。第一次使用請按下方「建立帳號」。";
    if (/already registered|already been registered/i.test(m)) return "這個 Email 已經註冊過了，請直接登入。";
    if (/password/i.test(m) && /6/.test(m)) return "密碼至少要 6 個字元。";
    if (/rate limit/i.test(m)) return "嘗試太多次，請稍等幾分鐘再試。";
    if (/failed to fetch|network/i.test(m)) return "連不上網路，請確認網路後再試。";
    return "發生錯誤：" + m;
  }
  async function enter(u) {
    user = u; loadLocal(); showMain();
    $("who").textContent = "登入帳號：" + (u.email || "");
    $("goal").value = state.goal;
    render(); refreshChip(); syncAll();
  }
  async function onAuthSubmit(e) {
    e.preventDefault(); authMsg("");
    var email = $("email").value.trim(), pw = $("pw").value;
    var btn = $("auth-submit"); btn.disabled = true;
    try {
      if (signUpMode) {
        var r = await sb.auth.signUp({ email: email, password: pw });
        if (r.error) { authMsg(explain(r.error), "err"); }
        else if (r.data && r.data.session) { await enter(r.data.session.user); }
        else { authMsg("帳號已建立。請到信箱點確認連結後，再回來登入。", "ok"); }
      } else {
        var s = await sb.auth.signInWithPassword({ email: email, password: pw });
        if (s.error) authMsg(explain(s.error), "err"); else await enter(s.data.user);
      }
    } catch (err) { authMsg(explain(err), "err"); }
    btn.disabled = false;
  }
  function setMode(signup) {
    signUpMode = signup;
    $("auth-submit").textContent = signup ? "建立帳號" : "登入";
    $("auth-switch").textContent = signup ? "已經有帳號？回去登入" : "第一次使用？建立帳號";
    $("pw").setAttribute("autocomplete", signup ? "new-password" : "current-password");
    authMsg("");
  }

  /* ---------- wiring ---------- */
  function setTab(name) {
    tab = name;
    ["today", "week", "month"].forEach(function (k) { $("v-" + k).hidden = k !== name; $("t-" + k).setAttribute("aria-selected", k === name ? "true" : "false"); });
  }
  async function boot() {
    var q = $("quick");
    [150, 250, 350, 500].forEach(function (ml, i) {
      var b = document.createElement("button"); b.type = "button";
      b.innerHTML = "+" + ml + "<small>" + ["小口", "一杯", "大杯", "一瓶"][i] + "</small>";
      b.addEventListener("click", function () { addLog(ml); });
      q.appendChild(b);
    });
    document.querySelectorAll(".tabs button").forEach(function (b) { b.addEventListener("click", function () { setTab(b.getAttribute("data-tab")); }); });
    $("custom-form").addEventListener("submit", function (e) { e.preventDefault(); addLog(parseInt($("custom-ml").value, 10)); $("custom-ml").value = ""; });
    $("goal-save").addEventListener("click", saveGoal);
    $("settings").addEventListener("toggle", function () { if ($("settings").open) $("goal").value = state.goal; });
    $("auth-form").addEventListener("submit", onAuthSubmit);
    $("auth-switch").addEventListener("click", function () { setMode(!signUpMode); });
    $("logout").addEventListener("click", async function () { try { await sb.auth.signOut(); } catch (e) {} user = null; showAuth(); });
    window.addEventListener("online", function () { syncAll(); });
    window.addEventListener("offline", refreshChip);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { if (user && dayKey(new Date()) !== curKey) render(); if (user) syncAll(); } });
    setInterval(function () { if (user && dayKey(new Date()) !== curKey) render(); }, 30000);

    if (!window.supabase || !CFG.url || !CFG.key || /YOUR_/.test(CFG.key)) {
      showAuth(); authMsg(!window.supabase ? "載入不到登入元件，請確認網路後重新整理。" : "網站還沒填入 Supabase 設定（config.js）。", "err");
      return;
    }
    sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } });
    try {
      var s = await sb.auth.getSession();
      if (s.data && s.data.session) { await enter(s.data.session.user); return; }
    } catch (e) {}
    showAuth();
  }
  boot();
})();
