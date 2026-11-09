/* Connects the page to the clan's own server (replaces the Claude services the preview used). */
(function () {
  'use strict';
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } return null; }
  var token = ls('k1token') || '';
  var dev = ls('k1dev');
  if (!dev) {
    var a = new Uint8Array(10); (window.crypto || {}).getRandomValues && crypto.getRandomValues(a);
    dev = 'dev_' + Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('') + Math.random().toString(36).slice(2, 6);
    ls('k1dev', dev);
  }

  function req(method, url, body, raw) {
    var h = { 'x-device': dev };
    if (token) h.authorization = 'Bearer ' + token;
    var opt = { method: method, headers: h };
    if (raw) { h['content-type'] = raw.type || 'application/octet-stream'; opt.body = raw; }
    else if (body !== undefined) { h['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('http ' + r.status)); e.status = r.status; e.code = (r.status === 401 || r.status === 403) ? 'invalid_argument' : 'error'; throw e; }
        return j;
      });
    });
  }
  var meP = null;
  function loadMe() {
    meP = req('GET', '/api/me').then(function (m) { if (!m.id && token) { token = ''; ls('k1token', null); } return m; }).catch(function () { return { id: null }; });
    return meP;
  }
  loadMe();

  /* ---------- live updates: ask the server if anything changed ---------- */
  var subs = [], lastV = -1, pollMs = 3000, pollT = null;
  function poll() {
    clearTimeout(pollT);
    if (document.hidden) { pollT = setTimeout(poll, pollMs); return; }
    fetch('/api/version').then(function (r) { return r.json(); }).then(function (j) {
      if (j.poll) pollMs = Math.max(2000, j.poll);
      if (j.v !== lastV) { lastV = j.v; subs.slice().forEach(function (s) { s.refresh(); }); }
    }).catch(function () { /* offline: keep what is on screen */ }).then(function () { pollT = setTimeout(poll, pollMs); });
  }
  poll();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  function bump() { setTimeout(function () { lastV = -1; subs.slice().forEach(function (x) { x.refresh(); }); }, 120); }

  function snapDoc(id, d) { return { id: id, exists: true, data: function () { return JSON.parse(JSON.stringify(d)); } }; }
  function watch(fetcher, make, next, err) {
    var last = null, sub = {
      refresh: function () {
        fetcher().then(function (j) {
          var s = JSON.stringify(j);
          if (s === last) return; last = s;
          next(make(j));
        }).catch(function (e) { if (e && e.status && err) err(e); });
      },
    };
    subs.push(sub); sub.refresh();
    return function () { subs = subs.filter(function (x) { return x !== sub; }); };
  }

  /* ---------- write, asking for a login code first when one is needed ---------- */
  function write(method, url, body, raw) {
    return req(method, url, body, raw).then(function (r) { bump(); return r; }, function (e) {
      if (e.status === 401) return promptLogin().then(function () { return req(method, url, body, raw); }).then(function (r) { bump(); return r; });
      throw e;
    });
  }
  function newId() { var a = new Uint8Array(8); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }

  function docRef(path) {
    var parts = path.split('/');
    var url = '/api/d/' + encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]);
    return {
      id: parts[1], path: path,
      get: function () { return req('GET', url).then(function (j) { return j.exists ? snapDoc(parts[1], j.data) : { id: parts[1], exists: false, data: function () { return undefined; } }; }); },
      set: function (d) { return write('PUT', url, d); },
      update: function (d) { return write('PATCH', url, d); },
      delete: function () { return write('DELETE', url); },
      onSnapshot: function (next, err) {
        return watch(function () { return req('GET', url); }, function (j) { var s = j.exists ? snapDoc(parts[1], j.data) : { id: parts[1], exists: false, data: function () { return undefined; } }; s.metadata = { fromCache: false }; return s; }, next, err);
      },
    };
  }
  function colRef(name, q) {
    q = q || {};
    function qs() { var p = []; if (q.order) p.push('order=' + encodeURIComponent(q.order), 'dir=' + (q.dir || 'asc')); if (q.limit) p.push('limit=' + q.limit); return p.length ? '?' + p.join('&') : ''; }
    function fetchList() { return req('GET', '/api/c/' + encodeURIComponent(name) + qs()); }
    function make(j) { var docs = j.docs.map(function (d) { return snapDoc(d.id, d.data); }); return { docs: docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false } }; }
    return {
      orderBy: function (f, d) { return colRef(name, { order: f, dir: d, limit: q.limit }); },
      limit: function (n) { return colRef(name, { order: q.order, dir: q.dir, limit: n }); },
      get: function () { return fetchList().then(make); },
      onSnapshot: function (next, err) { return watch(fetchList, make, next, err); },
      doc: function (id) { return docRef(name + '/' + (id || newId())); },
      add: function (d) { return write('POST', '/api/c/' + encodeURIComponent(name), d).then(function (j) { return docRef(name + '/' + j.id); }); },
    };
  }
  var dbShim = { collection: function (n) { return colRef(n); }, doc: function (p) { return docRef(p); } };
  var userShim = {
    id: function () { return meP.then(function (m) { return m.id || dev; }); },
    canEdit: function () { return meP.then(function (m) { return !!m.admin; }); },
    isOwner: function () { return meP.then(function (m) { return !!m.owner; }); },
    can: function () { return Promise.resolve(true); },
  };
  /* shrink big pictures so they upload fast and fit the database */
  function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || (file.size < 450 * 1024)) return Promise.resolve(file);
    return new Promise(function (resolve) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 1400, sc = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        var q = 0.85;
        (function go() { c.toBlob(function (b) { if (!b) return resolve(file); if (b.size > 560 * 1024 && q > 0.4) { q -= 0.12; return go(); } resolve(b); }, 'image/jpeg', q); })();
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  var assetsShim = {
    upload: function (file) {
      return shrink(file).then(function (blob) { return write('POST', '/api/assets', undefined, blob); });
    },
  };
  window.k1Claim = function (id, phone, uid) { return req('POST', '/api/claim', { id: id, phone: phone, uid: uid || '' }).then(function (r) { bump(); return r; }); };
  window.claude = { use: function (n) { return Promise.resolve(n === 'db' ? dbShim : n === 'user' ? userShim : n === 'assets' ? assetsShim : null); } };

  /* ---------- login window ---------- */
  var loginP = null;
  function esc(t) { var s = document.createElement('span'); s.textContent = t; return s.innerHTML; }
  function promptLogin() {
    if (loginP) return loginP;
    loginP = new Promise(function (resolve, reject) {
      req('GET', '/api/c/roster').then(function (j) {
        var roles = {};
        return req('GET', '/api/c/roles').then(function (r) { r.docs.forEach(function (d) { roles[d.id] = d.data.role; }); return j; }).then(function (j2) {
          var ids = j2.docs.slice().sort(function (x, y) { return x.data.name.localeCompare(y.data.name); });
          var wrap = document.createElement('div');
          wrap.style.cssText = 'position:fixed;inset:0;z-index:300;display:grid;place-items:center;background:rgba(5,5,7,.8);padding:16px';
          var me = ls('k1me') || '';
          var opts = ids.map(function (d) { return '<option value="' + esc(d.id) + '"' + (d.id === me ? ' selected' : '') + '>K1۝' + esc(d.data.name) + (d.data.person ? ' (' + esc(d.data.person) + ')' : '') + (roles[d.id] ? ' - ' + esc(roles[d.id]) : '') + '</option>'; }).join('');
          wrap.innerHTML = '<form class="panel" style="max-width:380px;width:100%;max-height:100%;overflow:auto"><h3>Log in</h3><p class="hint">Choose your name and type the code a leader gave you. You stay logged in on this phone.</p><div class="stack" style="margin-top:12px"><label class="field-row" for="k1lm">Your name<select id="k1lm">' + opts + '</select></label><label class="field-row" for="k1lc">Login code<input id="k1lc" type="password" inputmode="numeric" autocomplete="one-time-code" placeholder="6 digits"></label><div class="status err" id="k1le" role="alert" style="min-height:0;margin:0"></div><div class="row-btns"><button class="btn primary" type="submit">Log in</button><button class="btn" type="button" id="k1lx">Cancel</button></div></div></form>';
          document.body.appendChild(wrap);
          var form = wrap.querySelector('form'), sel = wrap.querySelector('#k1lm'), code = wrap.querySelector('#k1lc'), er = wrap.querySelector('#k1le');
          code.focus();
          function close() { wrap.remove(); loginP = null; }
          wrap.querySelector('#k1lx').addEventListener('click', function () { close(); var e = new Error('cancelled'); e.code = 'invalid_argument'; reject(e); });
          form.addEventListener('submit', function (ev) {
            ev.preventDefault(); er.textContent = '';
            req('POST', '/api/login', { id: sel.value, code: code.value }).then(function (j) {
              token = j.token; ls('k1token', token); ls('k1me', sel.value); if (j.me && j.me.name) ls('k1name', j.me.name);
              close(); resolve();
              setTimeout(function () { location.reload(); }, 400);
            }, function (e) { er.textContent = e.status === 429 ? 'Too many tries. Wait a few minutes.' : 'Wrong name or code.'; });
          });
        });
      }).catch(function (e) { loginP = null; reject(e); });
    });
    loginP.catch(function () { /* handled by caller */ });
    return loginP;
  }

  /* ---------- page extras once it has loaded ---------- */
  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function () {
    meP.then(function (me) {
      var nav = document.querySelector('.bar nav');
      if (nav) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'linkbtn'; b.style.cssText = 'white-space:nowrap;padding:8px 12px';
        b.textContent = me.id ? 'Log out' : 'Log in';
        b.addEventListener('click', function () {
          if (me.id) req('POST', '/api/logout').finally(function () { token = ''; ls('k1token', null); location.reload(); });
          else promptLogin().catch(function () {});
        });
        nav.appendChild(b);
      }
      if (me.admin) addCodesPanel();
    });
  });

  function addCodesPanel() {
    var plan = document.querySelector('#setup .plan');
    if (!plan) return;
    var p = document.createElement('div');
    p.className = 'panel';
    p.innerHTML = '<h3>Login codes</h3><p class="hint">Make a personal code for each leader, or for any member who wants to edit their own details. They log in once and stay logged in on that phone. Making a new code stops the old one.</p><div class="stack" style="margin-top:10px"><label class="field-row" for="cdMember">Member<select id="cdMember"></select></label><div class="row-btns"><button type="button" class="btn primary" id="cdMake">Make a new code</button></div><div id="cdOut"></div></div>';
    plan.appendChild(p);
    var sel = p.querySelector('#cdMember'), out = p.querySelector('#cdOut');
    function fill() {
      Promise.all([req('GET', '/api/c/roster'), req('GET', '/api/c/roles'), req('GET', '/api/codes')]).then(function (r) {
        var roles = {}; r[1].docs.forEach(function (d) { roles[d.id] = d.data.role; });
        var has = {}; (r[2].ids || []).forEach(function (i) { has[i] = 1; });
        var keep = sel.value;
        sel.textContent = '';
        r[0].docs.slice().sort(function (x, y) { return x.data.name.localeCompare(y.data.name); }).forEach(function (d) {
          var o = document.createElement('option'); o.value = d.id;
          o.textContent = 'K1۝' + d.data.name + (d.data.person ? ' (' + d.data.person + ')' : '') + (roles[d.id] ? ' - ' + roles[d.id] : '') + (has[d.id] ? ' - has a code' : '');
          sel.appendChild(o);
        });
        if (keep) sel.value = keep;
      });
    }
    fill();
    p.querySelector('#cdMake').addEventListener('click', function () {
      var id = sel.value; if (!id) return;
      var label = sel.options[sel.selectedIndex].textContent.split(' - ')[0];
      out.textContent = '';
      req('POST', '/api/codes', { id: id }).then(function (j) {
        return req('GET', '/api/d/contacts/' + encodeURIComponent(id)).then(function (c) { return { code: j.code, phone: c.exists && c.data.phone }; }, function () { return { code: j.code }; });
      }).then(function (j) {
        var box = document.createElement('div'); box.className = 'remind';
        var big = document.createElement('div'); big.style.cssText = 'font:700 34px/1 var(--mono);letter-spacing:.12em'; big.textContent = j.code;
        var note = document.createElement('p'); note.className = 'hint'; note.textContent = 'Code for ' + label + '. It is shown only now. Send it to them privately.';
        var row = document.createElement('div'); row.className = 'row-btns';
        var msg = 'Your Kenya One site login code is ' + j.code + '. Open ' + location.origin + ' , tap Log in, choose your name and type the code.';
        if (j.phone) { var a = document.createElement('a'); a.className = 'btn small'; a.target = '_blank'; a.rel = 'noopener'; a.href = 'https://wa.me/' + j.phone + '?text=' + encodeURIComponent(msg); a.textContent = 'Send on WhatsApp'; row.appendChild(a); }
        else { var n = document.createElement('span'); n.className = 'muted'; n.textContent = 'No WhatsApp number saved for this member. Edit them to add one.'; row.appendChild(n); }
        box.append(big, note, row); out.textContent = ''; out.appendChild(box);
        fill();
      }).catch(function (e) { out.textContent = e.status === 403 ? 'Only a Master can make codes for leaders.' : 'Could not make a code. Try again.'; });
    });
  }
})();
