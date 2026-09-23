/* MailDrop — the browser layer. Owns DOM ids; the logic lives in the other
   lib files so it can be unit-tested without a page. */
(function (global) {
  'use strict';
  var MD = (global.MD = global.MD || {});
  var U = MD.util;
  // A transfer can outlive the page it belongs to — the user navigates, the tab
  // closes — and a UI write that throws would replace the message the user needed
  // with a crash nobody sees. Every lookup goes through here, so a missing
  // document reads as "no such element" and the callers already cope with that.
  var $ = function (id) {
    var d = global.document;
    return d && d.getElementById ? d.getElementById(id) : null;
  };
  var UI = {};
  global.UI = UI;

  var els = {};
  var logLines = [];

  /* Once the page is gone there is nothing to write to, and writing anyway must
     not throw: these updates arrive from transfer callbacks, often from a catch
     block, and a crash here would replace the message the user needed. A missing
     element while the page is alive is a different matter — that stays a null, so
     a typo in an id still shows up as a failure instead of silence. */
  var INERT = {
    className: '', textContent: '', innerHTML: '', value: '', href: '', title: '', download: '',
    hidden: false, disabled: false, checked: false, scrollTop: 0, scrollHeight: 0, offsetTop: 0,
    style: {}, children: [], childNodes: [], dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: function () { return false; } },
    firstChild: null, lastChild: null, parentNode: null, ownerDocument: null, nextSibling: null,
    appendChild: noop, removeChild: noop, insertBefore: noop, replaceChild: noop, replaceWith: noop,
    setAttribute: noop, removeAttribute: noop, getAttribute: function () { return null; },
    addEventListener: noop, removeEventListener: noop, dispatchEvent: function () { return true; },
    click: noop, focus: noop, blur: noop, select: noop, scrollIntoView: noop, remove: noop,
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    closest: function () { return null; }, getBoundingClientRect: function () { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  };
  function noop() { }

  function id(x) {
    var e = els[x] || (els[x] = $(x));
    return e || (global.document ? null : INERT);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  // log() must never call back into error/warn — an earlier version did, and the
  // first error on screen blew the stack. Log writes the console pane, nothing else.
  function log(kind, msg) {
    logLines.push((kind === 'e' ? '\u2717 ' : kind === 'w' ? '! ' : kind === 's' ? '\u2713 ' : '  ') +
      new Date().toISOString().slice(11, 19) + ' ' + msg);
    if (logLines.length > 400) logLines.shift();
    var box = id('console');
    if (box) box.textContent = logLines.join('\n');
    try {
      if (global.console) (kind === 'e' ? global.console.error : kind === 'w' ? global.console.warn : global.console.log).call(global.console, '[maildrop] ' + msg);
    } catch (e) { }
  }
  UI.log = log;

  UI.error = function (msg) { log('e', msg); banner(msg, 'bad'); };
  UI.warn = function (msg) { log('w', msg); banner(msg, 'warn'); };
  UI.note = function (msg) { log('s', msg); banner(msg, 'ok'); };
  function banner(msg, kind) {
    var box = id('linkNote');
    if (box && kind === 'ok' && !id('linkCard').hidden) { box.className = 'note ' + (kind === 'bad' ? 'bad' : kind === 'warn' ? 'warn' : 'ok'); box.textContent = msg; return; }
    // errors belong where the eye already is, not inside a folded panel
    var ctx = id('banners') || id('context');
    var doc = ctx && ctx.ownerDocument;
    // A transfer can report its failure after the page it belongs to is gone
    // (the user navigated, the tab closed). Writing into a dead document would
    // throw, and that throw would replace the message the user needed.
    if (!doc || typeof doc.createElement !== 'function') return;
    var d = doc.createElement('div');
    d.className = 'pill ' + (kind === 'bad' ? 'bad' : kind === 'warn' ? 'warn' : 'ok');
    d.style.whiteSpace = 'normal';
    d.textContent = msg;
    d.title = 'Click to dismiss';
    d.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
    d.onclick = function () { if (d.parentNode) d.parentNode.removeChild(d); };
    ctx.appendChild(d);
    // an error stays until you acknowledge it — one that fades out on a timer is
    // an error you never read — but they do not stack up either
    while (ctx.children.length > 3) ctx.removeChild(ctx.firstChild);
    if (kind !== 'bad') setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 6000);
  }

  UI.setBusy = function (busy) {
    id('btnStart').disabled = busy || !MD.app.state.files.length;
    id('btnDemo').disabled = busy;
    id('btnCancel').hidden = !busy;
    if (id('sendSetup')) id('sendSetup').hidden = !!busy;
    if (id('btnCancelRun2')) id('btnCancelRun2').hidden = !busy;
    if (id('btnDownload')) id('btnDownload').disabled = busy || !MD.app.state.receive.resultBlob;
    /* Losing the tab halfway through a 5 GiB upload costs the whole transfer, and
       nothing in the page would tell you. A beforeunload handler is the only way a
       page can ask before that happens; the browser writes the words, not us. */
    try {
      global.onbeforeunload = busy ? function (ev) {
        ev.preventDefault();
        ev.returnValue = '';
        return '';
      } : null;
    } catch (e) { }
  };

  UI.show = function (what) {
    if (what === 'progress') { id('progressCard').hidden = false; id('progBar').style.width = '0%'; id('progPill').textContent = 'working'; id('progPill').className = 'pill'; }
  };

  UI.progress = function (done, total, msg, fracOverride) {
    var f = fracOverride != null ? fracOverride : (total ? done / total : 0);
    id('progBar').style.width = Math.max(0, Math.min(100, f * 100)).toFixed(1) + '%';
    if (msg != null) id('progMsg').textContent = msg;
  };

  UI.receivePhase = function (t) { id('recvMsg').textContent = t; };
  UI.receiveDone = function () { id('progPill').textContent = 'idle'; };

  // ------------------------------------------------------------- tabs & boot
  function tab(name) {
    ['send', 'receive', 'settings'].forEach(function (n) {
      var p = id('panel-' + n);
      if (p) p.className = (n === name ? 'on' : '');
      var b = global.document && global.document.querySelector ? global.document.querySelector('nav button[data-tab=' + n + ']') : null;
      if (b) b.className = (n === name ? 'on' : '');
    });
    try { global.history.replaceState(null, '', '#' + (name === 'send' ? '' : name)); } catch (e) { }
  }
  UI.tab = tab;

  function contextBadges() {
    var ctx = id('context');
    var secure = global.isSecureContext !== false;
    var out = [];
    out.push('<span class="pill ' + (secure ? 'ok' : 'warn') + '">' + (secure ? 'secure context ✓ (WebCrypto on)' : 'insecure context — encryption unavailable') + '</span>');
    out.push('<span class="pill">' + (MD.backends.selfhostConfigured(MD.app.state.cfg.s3) ? 'own bucket configured ✓' : 'no own bucket yet — public host limits apply') + '</span>');
    if (typeof global.showSaveFilePicker === 'function') out.push('<span class="pill ok">stream-to-disk save available</span>');
    out.push('<span class="pill">email attachments cap ≈18 MB of real bytes → that is why you are here</span>');
    ctx.innerHTML = out.join('');
    var sum = id('ctxSum');
    if (sum) {
      var warn = ctx.querySelectorAll('.pill.warn, .pill.bad').length;
      sum.textContent = warn ? 'This browser: ' + warn + ' thing(s) to know about' : 'This browser is ready (' + out.length + ' checks)';
      var wrap = id('ctxWrap');
      if (wrap && warn) wrap.open = true;
    }
  }
  UI.contextBadges = contextBadges;

  // ---------------------------------------------------------------- send side
  function renderFiles() {
    var f = MD.app.state.files;
    var box = id('fileList');
    if (!box) return;
    if (!f.length) { box.innerHTML = ''; id('btnStart').disabled = true; id('btnStart').textContent = 'Choose a file first'; renderPlan(); return; }
    // summary above the list when there is more than one file: the transfer is one archive
    var pre = '';
    if (f.length > 1) {
      var tot = MD.app.sourceSize ? MD.app.sourceSize(f) : f.reduce(function (a,x){return a+(Number(x.size)||0);},0);
      var name = MD.pack && MD.pack.archiveName ? MD.pack.archiveName(f) : 'files.zip';
      pre = '<div class="note" style="margin-bottom:8px">' + f.length + ' files → <b>' + esc(name) + '</b> (' + U.fmtBytes(tot) + ' incl. zip framing) — stored, not compressed</div>';
    }
    box.innerHTML = pre + f.map(function (x, i) {
      // lastModified is not guaranteed — a file that arrived by drag, or a
      // stand-in object with only a name and a size, has none. An invalid Date
      // must not take the whole list down with it.
      var when = x.lastModified ? new Date(Number(x.lastModified)) : null;
      var mod = when && isFinite(when.getTime()) ? ' · modified ' + when.toISOString().slice(0, 10) : '';
      return '<div class="fl"><div><div class="nm">' + esc(x.name) + '</div>' +
        '<div class="mt">' + U.fmtBytes(x.size) + ' · ' + esc(x.type || 'unknown type') + mod + '</div></div>' +
        '<button class="x" data-rm="' + i + '">remove</button></div>';
    }).join('');
    box.querySelectorAll('[data-rm]').forEach(function (b) {
      b.onclick = function () {
        MD.app.state.files.splice(Number(b.getAttribute('data-rm')), 1);
        renderFiles();
      };
    });
    id('btnStart').disabled = MD.app.state.busy || !f.length;
    renderPlan();
  }
  UI.renderFiles = renderFiles;

  UI.setStartLabel = function (t) { id('btnStart').textContent = t; };

  function renderPlan() {
    var box = id('planBox');
    var f = MD.app.state.files;
    var backend = MD.backends.get(MD.app.state.cfg.backend) || MD.backends.list[0];

    if (backend.noUpload) {
      id('btnStart').textContent = 'Make the link';
      id('btnStart').disabled = MD.app.state.busy;
      var url = (MD.app.state.directUrl || '').trim();
      var verr = MD.app.validateFiles([]);
      if (!url) { box.innerHTML = '<div class="note">Paste a URL above to continue.</div>'; return; }
      box.innerHTML = '<div class="row" style="margin-top:14px"><span class="pill">' + esc(backend.label.split(' —')[0]) +
        '</span><span class="pill">no upload, no size cap from us</span><span class="pill">file: ' + esc(url.split('/').pop().slice(0, 40)) + '</span></div>' +
        (verr.length ? verr.map(function (e) { return '<div class="note bad">' + esc(e) + '</div>'; }).join('') : '') +
        '<div class="note">The recipient will be sent to this URL. MailDrop cannot verify bytes it cannot read — if the host blocks cross-origin fetches, the page hands the link over instead.</div>';
      id('sendHint').textContent = 'wraps an existing link';
      return;
    }
    id('btnStart').textContent = 'Start transfer';

    var errs = f.length ? MD.app.validateFiles(f) : [];
    if (!f.length) { box.innerHTML = ''; id('btnStart').textContent = 'Choose a file first'; id('sendHint').textContent = ''; return; }
    var info = MD.app.plan(f);
    var total = info.total;
    var cap = info.cap;
    var n = info.count;
    var b = info.backend;
    var exp = MD.app.expiryMs(b);
    var est = info.linkChars || Math.max(260, n * 62 + 150);
    var html = '<div class="row" style="margin-top:14px">';
    html += '<span class="pill">' + esc(b.label.split(' —')[0]) + '</span>';
    html += '<span class="pill">' + n + ' part' + (n === 1 ? '' : 's') + ' × ≤ ' + U.fmtBytes(cap) + '</span>';
    if (exp) html += '<span class="pill">' + U.fmtDuration(exp / 3600000) + ' on the host</span>';
    html += '<span class="pill">link ≈ ' + est + ' chars</span>';
    if (MD.app.state.cfg.password) html += '<span class="pill">AES-256-GCM</span>';
    html += '</div>';
    if (info.capRaised) {
      html += '<div class="note warn">Per-part size was raised to <b>' + esc(MD.util.fmtBytes(cap)) +
        '</b> so the link still fits in an email. Smaller parts would have made a link the mail client breaks.</div>';
    }
    if (!info.linkFits) {
      html += '<div class="note bad"><b>The link would be ' + est + ' characters</b>, past what a mail client ' +
        'keeps clickable (' + MD.app.MAX_TOKEN_CHARS + '). Bigger parts or your own bucket are the only ways out.</div>';
    }
    if (n > MD.app.MAX_PARTS_KEEN) {
      html += '<div class="note warn"><b>' + n + ' parts is a lot.</b> Each one is a separate HTTP request, so a flaky connection costs you ' + n +
        ' chances to fail. Raise the per-part size (or use your own bucket) to bring it down.</div>';
    }
    if (cap < MD.app.SOFT_MIN_PART && !errs.length) {
      html += '<div class="note">A part size below ' + U.fmtBytes(MD.app.SOFT_MIN_PART) + ' is fine for testing, slow for real sends.</div>';
    }
    if (info.archive) {
      html += '<div class="note">' + f.length + ' files travel as <b>' + esc(info.archive) + '</b> — one zip built in this browser, stored rather than compressed, so the recipient gets the bytes as they were.</div>';
    }
    if (n > 1) html += '<div class="note"><b>' + U.fmtBytes(total) + ' is more than one upload</b>, so it goes as ' + n +
      ' parts and comes back as <b>one link</b>. A part that fails retries on its own, and an attempt that dies outright' +
      ' continues where it stopped; your recipient notices nothing.</div>';
    var rz = MD.app.resumeFor ? MD.app.resumeFor(f[0]) : null;
    if (rz) {
      html += '<div class="note">An earlier attempt left <b>' + rz.done + ' of ' + rz.count + '</b> parts on ' +
        esc(String(b.label).split(' —')[0]) + ', and they are still there until ' + new Date(rz.until).toLocaleString() +
        '. Pressing Send keeps them and uploads only the ' + (rz.count - rz.done) + ' missing part' +
        (rz.count - rz.done === 1 ? '' : 's') +
        (typeof b.remove === 'function' ? ' — or remove them and start from the beginning: ' : ' — they cannot be removed from this host, so forgetting only drops the record: ') +
        '<button class="btn small" id="btnForgetResume">Start over</button></div>';
    }
    if (errs.length) html += errs.map(function (e) { return '<div class="note bad">' + esc(e) + '</div>'; }).join('');
    box.innerHTML = html;
    if (rz) {
      var fb = box.querySelector('#btnForgetResume');
      if (fb) fb.onclick = function () {
        fb.disabled = true;
        MD.app.forgetResume(f[0]).then(function (out) {
          if (!out) { UI.note('Nothing left to forget.'); return; }
          UI.note(out.removed
            ? (out.removed.gone + ' of ' + out.ids.length + ' part' + (out.ids.length === 1 ? '' : 's') +
               ' deleted from your bucket' + (out.removed.failed ? ', ' + out.removed.failed + ' could not be removed' : '') +
               ' — the next attempt starts from part 1.')
            : 'That attempt is forgotten. Parts already on the host stay until its clock deletes them, which is all a free host allows.');
          renderPlan();
        }, function (e) { UI.error(e.message || String(e)); renderPlan(); });
      };
    }
    var hint = errs.length ? errs[0] : U.fmtBytes(total) + ' → ' + String(b.label).split(' —')[0] +
      (exp ? ' · deleted after ' + U.fmtDuration(exp / 3600000) : '') + ' · one link for your recipient';
    id('sendHint').textContent = hint;
    id('btnStart').disabled = MD.app.state.busy || errs.length > 0;
    id('btnStart').textContent = errs.length ? 'Fix what is flagged above'
      : (MD.app.state.busy ? 'Sending…' : 'Send it' + (n > 1 ? ' — ' + n + ' parts' : ''));
  }
  UI.renderPlan = renderPlan;

  function fillProviders() {
    var sel = id('backendSel'), ssel = id('sBackend');
    var html = MD.backends.list.map(function (b) {
      var needSetup = b.key === 'selfhost' && !MD.backends.selfhostConfigured(MD.app.state.cfg.s3);
      return '<option value="' + b.key + '">' + esc(b.label) + (needSetup ? ' (not set up)' : '') + '</option>';
    }).join('');
    sel.innerHTML = ssel.innerHTML = html;
    sel.value = ssel.value = MD.app.state.cfg.backend;
    fillExpiry();
    blurb();
  }
  function fillExpiry() {
    var b = MD.backends.get(MD.app.state.cfg.backend) || MD.backends.list[0];
    var opts = (b.expiries || []).map(function (e) {
      return '<option value="' + e.v + '">' + esc(e.v === 'never' ? 'no expiry setting' : e.v) + '</option>';
    }).join('');
    id('expirySel').innerHTML = id('sExpiry').innerHTML = opts;
    var want = MD.app.state.cfg.expiry || b.defaultExpiry;
    id('expirySel').value = id('sExpiry').value = want;
    MD.app.state.cfg.expiry = id('expirySel').value;
  }
  function modeFields() {
    var b = MD.backends.get(MD.app.state.cfg.backend) || MD.backends.list[0];
    var drop = id('drop'), wrap = id('fileWrap'), box = id('directBox');
    var pw = id('pwWrap'), exp = id('expirySel'), cap = id('capInput');
    if (b.noUpload) {
      // nothing is uploaded, so there is nothing to split, expire or encrypt
      drop.hidden = true; wrap.hidden = true; box.hidden = false;
      id('btnDemo').hidden = true;
      pw.hidden = true; exp.disabled = true; cap.disabled = true;
      id('advSend').hidden = true;
    } else {
      drop.hidden = false; wrap.hidden = false; box.hidden = true;
      id('btnDemo').hidden = false;
      pw.hidden = false; exp.disabled = false; cap.disabled = false;
      id('advSend').hidden = false;
    }
  }

  function blurb() {
    var b = MD.backends.get(MD.app.state.cfg.backend) || MD.backends.list[0];
    var t = b.blurb || '';
    if (b.key === 'selfhost' && !MD.backends.selfhostConfigured(MD.app.state.cfg.s3)) {
      var missing = MD.backends.selfhost.validateCfg(MD.app.state.cfg.s3).join(', ');
      t += ' — needs: ' + missing + ' (Settings below)';
    }
    id('backendBlurb').textContent = t;
  }
  UI.fillProviders = function () { fillProviders(); renderPlan(); };

  // Some mail clients and spam filters choke on a 600-character link. Rather
  // than fight them, offer the parts as separate short links: the receive page
  // merges them into one job again.
  function renderBackupLinks(m) {
    var sec = id('linkBackup'), list = id('linkBackupList');
    var parts = MD.manifest.splitPerPart(m);
    if (parts.length < 2) { sec.hidden = true; list.innerHTML = ''; return; }
    sec.hidden = false;
    list.innerHTML = parts.map(function (pm, i) {
      return '<div class="row" style="margin-top:6px"><span class="mini">part ' + (i + 1) + ' of ' + parts.length +
        '</span><input class="in" readonly value="' + esc(MD.manifest.buildUrl(MD.app.receiveBaseUrl(), pm)) +
        '"><button class="btn small ghost" data-i="' + i + '">Copy</button></div>';
    }).join('');
    list.onclick = function (e) {
      var b = e.target.closest && e.target.closest('button');
      if (!b) return;
      var i = Number(b.getAttribute('data-i'));
      var pm = MD.manifest.splitPerPart(m)[i];
      if (!pm) return;
      MD.email.copyText(MD.manifest.buildUrl(MD.app.receiveBaseUrl(), pm)).then(function (ok2) {
        UI.note(ok2 ? 'Part ' + (i + 1) + ' copied — one link per email works.' : 'Copy blocked — select it manually.');
      });
    };
  }

  UI.showLink = function (link, m, token) {
    id('linkCard').hidden = false;
    id('linkText').value = link;
    UI.__token = token;
    UI.__manifest = m;
    id('linkStats').textContent = U.fmtBytes(m.z) + ' · ' + m.parts.length + ' part' + (m.parts.length === 1 ? '' : 's') + ' · ' + link.length + ' char link';
    // the address typed before sending is the address to use after — no need to type twice
    try {
      var saved = (MD.app.state.cfg.mailTo || '').trim();
      if (saved && id('toInput') && !String(id('toInput').value||'').trim()) id('toInput').value = saved;
      if (saved && id('toInputPre') && !String(id('toInputPre').value||'').trim()) id('toInputPre').value = saved;
    } catch (e) {}
    renderBackupLinks(m);
    var subj = MD.email.subjectFor(m, {});
    id('subjInput').value = subj;
    writeMailBody();
    id('linkNote').className = m.p === 'local' ? 'note warn' : 'note ok';
    id('linkNote').textContent = 'Link ready. Paste it into any mail client (Gmail, Outlook, Apple Mail) and send — or use the button above. ' +
      (m.d ? 'The host deletes the parts after ' + U.fmtDuration(m.d / 3600000) + '.' : '') +
      (m.p === 'local' ? ' This one lives in this browser only — do not email it, nobody else could open it. Use it to try the flow.' : '');
    if (navigator.share) id('btnShare').hidden = false;
  };

  function writeMailBody() {
    var m = UI.__manifest;
    if (!m) return;
    var link = id('linkText').value;
    var body = MD.email.bodyFor(m, link, {
      includeToken: !!id('includeToken').checked,
      from: ''
    });
    id('bodyText').value = body;
  }
  UI.writeMailBody = writeMailBody;

  // ----------------------------------------------------------- receive side
  UI.startReceive = function (m) {
    MD.app.state.receive.m = m;
    id('recvDirectRow').hidden = true;
    MD.app.state.receive.resultBlob = null;
    UI.__extra = null;
    tab('receive');
    UI.renderReceive(m);
    id('btnDownload').disabled = true;
    id('btnRetry').hidden = true;
    var needsPw = MD.receive.needsPassword(m);
    id('recvPwBox').hidden = !needsPw;
    id('recvMsg').textContent = needsPw ? 'This transfer is encrypted — type the password, then press Download.' : 'Ready. Press Download to fetch and rebuild it.';
    var missing = MD.manifest.missingParts(m);
    if (missing.length) {
      id('recvPill').textContent = 'incomplete';
      id('recvPill').className = 'pill warn';
      id('recvNote').className = 'note warn';
      id('recvNote').textContent = 'Parts ' + missing.map(function (i) { return i + 1; }).join(', ') + ' are still missing — paste the link from the other email with “Add another link”.';
    } else if (needsPw) {
      id('recvNote').className = 'note';
      id('recvNote').textContent = 'All ' + m.parts.length + ' parts present. Decryption happens in your browser with the password.';
    } else {
      id('recvNote').className = 'note';
      id('recvNote').textContent = 'Click Download. Nothing installs; the file is assembled in memory and then saved where you choose.';
    }
    // The sender put a deadline in the link, so say so before downloading
    if (m.x) {
      var left = m.x - Date.now();
      if (left < 0) {
        UI.warn('The sender set this to expire ' + U.fmtDuration(-left / 3600000) + ' ago (' +
          new Date(m.x).toLocaleString() + '). The host has probably deleted it — if the download fails, ask for a new link.');
      } else if (left < 6 * 3600000) {
        UI.note('Expires in ' + U.fmtDuration(left / 3600000) + ' — save it now.');
      }
    }
    // and say what a big file costs on a browser that cannot stream to disk
    if (m.z > 1610612736 && !MD.receive.canStreamSave() && m.f !== 'direct') {
      UI.warn('This browser saves the file in memory rather than as it downloads, and ' + U.fmtBytes(m.z) +
        ' is a lot of memory. Chrome or Edge on the same machine can write it straight to disk.');
    }

    if (m.f === 'direct') {
      UI.offerDirect(m.u || (m.parts[0] && m.parts[0].i) || '', 'The sender did not upload through MailDrop, so the file lives at that link.');
      id('btnDownload').disabled = true;
      id('recvNote').className = 'note';
      id('recvNote').textContent = 'Press the button above; the host will serve the file to your browser directly.';
      return;
    }
    // auto-start for plain transfers opened straight from the link
    if (!missing.length && !needsPw) MD.app.runReceive(m);
  };

  UI.offerDirect = function (url, why) {
    if (!url) return;
    // The URL came out of a manifest someone else wrote. Never put that in an
    // href unfiltered: javascript: or data: there is a one-click XSS in the page,
    // and this page keeps the bucket settings in localStorage.
    var safe = U.safeUrl(url, false);
    if (!safe) { UI.warn('The link named an address this page will not link to, so no button was added.'); return; }
    var row = id('recvDirectRow');
    row.hidden = false;
    id('recvDirect').setAttribute('href', safe);
    id('recvDirect').setAttribute('rel', 'noopener noreferrer');
    id('recvDirect').setAttribute('referrerpolicy', 'no-referrer');
    id('recvDirect').textContent = 'Open it on the host instead';
    id('recvDirectHint').textContent = why || 'MailDrop could not read the bytes from here, but a normal click works.';
  };

  UI.renderReceive = function (m) {
    id('recvCard').hidden = false;
    id('recvName').textContent = m.n;
    var meta = [];
    meta.push(U.fmtBytes(m.z));
    meta.push(m.parts.length + ' part' + (m.parts.length === 1 ? '' : 's'));
    if (m.d) meta.push('expires in ' + U.fmtDuration(m.d / 3600000) + ' (from send time)');
    meta.push('provider: ' + m.p);
    if (m.x) meta.push((m.x > Date.now() ? 'gone by ' : 'expired ')+ new Date(m.x).toLocaleString());
    if (m.h) meta.push('sha-256 fingerprint ' + m.h.slice(0, 8));
    id('recvMeta').innerHTML = meta.map(function (s) { return '<span class="pill">' + esc(s) + '</span>'; }).join(' ');
    id('recvParts').innerHTML = m.parts.map(function (p, i) {
      return '<span class="pill ' + (p.i ? 'ok' : 'warn') + '" style="margin:0 6px 6px 0">' + (i + 1) + '/' + m.parts.length +
        ' · ' + U.fmtBytes(p.s) + ' · ' + (p.i ? esc(String(p.i).slice(-10)) : 'missing') + '</span>';
    }).join('');
  };

  UI.receiveReady = function (m, res) {
    id('recvBar').style.width = '100%';
    id('recvPill').textContent = res.writtenToFile ? 'saved' : 'ready to save';
    if (res.checkMode === 'chain') {
      id('recvPill').textContent += res.verified ? ' · every part verified' : ' · parts do not match';
    }
    id('recvPill').className = 'pill ok';
    var bits = U.fmtBytes(res.bytes) + ' reassembled';
    if (m.e) bits += ' and decrypted';
    if (m.h) bits += ' · fingerprint ' + res.fingerprint.slice(0, 12) + ' matched';
    id('recvMsg').textContent = bits;
    UI.__resultBlob = res.blob;
    UI.__resultName = m.n;
    if (res.blob) {
      id('btnDownload').disabled = false;
      id('btnDownload').textContent = 'Save the file';
      id('recvNote').className = 'note ok';
      id('recvNote').textContent = 'Everything checked out. Press Save and pick where to put it.';
    } else {
      id('btnDownload').disabled = true;
      id('btnDownload').textContent = 'Saved ✓';
      id('recvNote').className = 'note ok';
      id('recvNote').textContent = 'Written straight to the file you chose — nothing was held in memory beyond one part.';
    }
  };

  UI.hideProgress = function () {
    var c = id('progressCard');
    if (c) c.hidden = true;
  };
  UI.receiveFail = function () { id('btnRetry').hidden = false; id('recvPill').textContent = 'failed'; id('recvPill').className = 'pill bad'; }
  UI.hostTrouble = function (backend, expMs) {
    var name = backend ? String(backend.label || backend.key).split(' —')[0] : 'that host';
    var hint = backend && backend.key === 'selfhost'
      ? 'Check the bucket CORS for ' + (id('sEp') ? (id('sEp').value || 'your endpoint') : 'your endpoint') + ': allow GET, PUT, HEAD, DELETE from ' + ((global.location && global.location.origin) || 'this page') + ' and expose ETag. The Settings → “Check this host from this device” button exercises the same path with 1 KiB and deletes it again.'
      : name + ' is refusing this network right now. That is not a page bug — a free host may block a carrier or datacenter range, or be rate-limiting. Try the “Check this host from this device” button (it sends 1 KiB, not your file), then either switch to your own bucket (Settings, free tier is enough) or retry on another network (phone hotspot).';
    // show as a second banner so it does not replace the error itself
    var ctx = id('banners') || id('context');
    var doc = ctx && ctx.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;
    var d = doc.createElement('div');
    d.className = 'pill warn';
    d.style.whiteSpace = 'normal';
    d.textContent = hint;
    d.title = 'Click to dismiss';
    d.onclick = function () { if (d.parentNode) d.parentNode.removeChild(d); };
    ctx.appendChild(d);
    while (ctx.children.length > 4) ctx.removeChild(ctx.firstChild);
  };

  // -------------------------------------------------------------- wiring
  function wire() {
    var drop = id('drop'), fi = id('fileInput');
    drop.onclick = function () { fi.click(); };
    fi.onchange = function () {
      var add = Array.prototype.slice.call(fi.files || []);
      if (add.length) {
        // append: picking again adds, it does not discard what is already there
        var cur = MD.app.state.files || [];
        // de-dupe by name+size+lastModified so a double-click does not double-count
        var seen = {};
        cur.forEach(function (f) { seen[f.name + '|' + f.size + '|' + (f.lastModified || 0)] = 1; });
        add.forEach(function (f) {
          var k = f.name + '|' + f.size + '|' + (f.lastModified || 0);
          if (!seen[k]) { cur.push(f); seen[k] = 1; }
        });
        MD.app.state.files = cur;
        renderFiles();
      }
      try { fi.value = ''; } catch (e) {}
    };
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hot'); });
    });
    drop.addEventListener('drop', function (e) {
      var items = e.dataTransfer && e.dataTransfer.files;
      if (items && items.length) {
        var add = Array.prototype.slice.call(items);
        var cur = MD.app.state.files || [];
        var seen = {};
        cur.forEach(function (f) { seen[f.name + '|' + f.size + '|' + (f.lastModified || 0)] = 1; });
        add.forEach(function (f) {
          var k = f.name + '|' + f.size + '|' + (f.lastModified || 0);
          if (!seen[k]) { cur.push(f); seen[k] = 1; }
        });
        MD.app.state.files = cur;
        renderFiles();
      }
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });

    document.querySelectorAll('nav button').forEach(function (b) {
      b.onclick = function () { tab(b.getAttribute('data-tab')); };
    });

    id('backendSel').onchange = function () { MD.app.state.cfg.backend = this.value; MD.app.saveCfg(); fillExpiry(); blurb(); modeFields(); renderPlan(); };
    id('directUrl').oninput = function () { MD.app.state.directUrl = this.value.trim(); renderPlan(); };
    id('directUrl').onkeydown = function (e) {
      if (e.key === 'Enter' && !id('btnStart').disabled) { e.preventDefault(); id('btnStart').click(); }
    };
    id('expirySel').onchange = function () { MD.app.state.cfg.expiry = this.value; MD.app.saveCfg(); renderPlan(); };
    id('capInput').oninput = function () { MD.app.state.cfg.partCapBytes = this.value; MD.app.saveCfg(); renderPlan(); };
    id('pwInput').oninput = function () { MD.app.state.cfg.password = this.value; MD.app.saveCfg(); renderPlan(); };
    id('includeToken').onchange = function () { MD.app.state.cfg.includeTokenInMail = this.checked; MD.app.saveCfg(); writeMailBody(); };

    id('btnStart').onclick = function () { MD.app.runSend(); };
    id('btnStart').textContent = 'Start transfer';
    id('btnCancel').onclick = cancelRun;
    id('btnCancelRun2').onclick = cancelRun;
    id('btnDemo').onclick = makeDemoFile;

    id('btnCopyLink').onclick = function () { MD.email.copyText(id('linkText').value).then(function (ok) { UI.note(ok ? 'Link copied.' : 'Copy blocked — select it manually.'); }); };
    id('btnCopyCode').onclick = function () { MD.email.copyText(UI.__token).then(function (ok) { UI.note(ok ? 'Raw code copied (' + UI.__token.length + ' chars).' : 'Copy blocked.'); }); };
    id('btnOpenLink').onclick = function () {
      var key = MD.app.state.cfg.backend;
      if (key === 'local') {
        // The in-page test backend holds parts in this tab's memory, so another
        // tab literally cannot see them. Replay the flow here instead of sending
        // the user to a page that can only fail.
        UI.log('Test mode keeps parts in this tab, so the preview runs in place.');
        tab('receive');
        UI.startReceive(UI.__manifest);
        return;
      }
      global.open(id('linkText').value, '_blank', 'noopener');
    };
    id('btnShare').onclick = function () { MD.email.share(id('linkText').value); };
    // keep the two address fields (pre-send and in-card) in sync and remembered on this device
    function syncMailTo(val) {
      var v = String(val || '').trim();
      MD.app.state.cfg.mailTo = v;
      MD.app.saveCfg();
      var a = id('toInput'), b = id('toInputPre');
      if (a && a.value !== v) a.value = v;
      if (b && b.value !== v) b.value = v;
    }
    var preMail = id('toInputPre');
    if (preMail) {
      preMail.oninput = function () { syncMailTo(this.value); };
      preMail.onchange = function () { syncMailTo(this.value); };
    }
    var postMail = id('toInput');
    if (postMail) {
      postMail.oninput = function () { syncMailTo(this.value); };
      postMail.onchange = function () { syncMailTo(this.value); };
    }
    id('btnMailto').onclick = function () {
      var cur = (id('toInput') && id('toInput').value) || (id('toInputPre') && id('toInputPre').value) || '';
      syncMailTo(cur);
      var ok = MD.email.openInClient(String(cur).trim(), id('subjInput').value, id('bodyText').value);
      UI.note(ok
        ? 'Handed to your mail app — check the address and the link, then send. If no app opened, use one of the two buttons below.'
        : 'No mail app answered. Use the Gmail or Outlook button, or copy the whole message and paste it into any mail client.');
    };

    // Webmail, only when clicked: no request leaves this page before then, and the
    // address goes through the same filter mailto: uses, so a pasted "Name <a@b.c>"
    // cannot smuggle a second recipient into the query string.
    function composeVia(provider) {
      var cur = (id('toInput') && id('toInput').value) || (id('toInputPre') && id('toInputPre').value) || '';
      syncMailTo(cur);
      var c;
      try {
        c = MD.email.composeUrl(provider, String(cur).trim(), id('subjInput').value, id('bodyText').value);
      } catch (e) { UI.note(e.message); return; }
      if (c.dropped && c.dropped.length) UI.note('Not used, since it is not an address: ' + c.dropped.join(', '));
      var w = null;
      try { w = global.open(c.url, '_blank', 'noopener'); } catch (e) { w = null; }
      UI.note(w
        ? 'Draft opened in a new tab — check the address, then send.'
        : 'The browser blocked the new tab. Allow pop-ups for this page, or copy the whole message instead.');
    }
    var bg = id('btnGmail');
    if (bg) bg.onclick = function () { composeVia('gmail'); };
    var bo = id('btnOutlook');
    if (bo) bo.onclick = function () { composeVia('outlook'); };
    id('btnCopyMail').onclick = function () {
      var cur = (id('toInput') && id('toInput').value) || (id('toInputPre') && id('toInputPre').value) || '';
      syncMailTo(cur);
      var txt = 'To: ' + String(cur).trim() + '\nSubject: ' + id('subjInput').value + '\n\n' + id('bodyText').value;
      MD.email.copyText(txt).then(function (ok) { UI.note(ok ? 'Message copied — paste into your mail client.' : 'Copy blocked; select the text above.'); });
    };
    id('btnCopyFile').onclick = function () {
      var txt = 'To: ' + id('toInput').value.trim() + '\nSubject: ' + id('subjInput').value + '\n\n' + id('bodyText').value + '\n';
      var blob = new Blob([txt], { type: 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'maildrop-message.txt';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    };
    id('subjInput').onchange = writeMailBody;
    id('bodyText').onchange = function () { };

    id('btnClearHist').onclick = function () { try { global.localStorage.removeItem('maildrop.history.v1'); } catch (e) { } renderHistory(); };
    id('btnConsole').onclick = function () { id('console').classList.toggle('on'); };

    // receive
    id('btnDecode').onclick = function () {
      var t = id('pasteBox').value;
      if (!t.trim()) { UI.error('Paste the link (or the whole email) first.'); return; }
      MD.app.pasteToken(t);
    };
    id('btnAddPart').onclick = function () {
      var t = global.prompt('Paste the link (or email) for the remaining parts:');
      if (t) MD.app.pasteToken(t);
    };
    id('btnApplyPw').onclick = function () { MD.app.state.receive.password = id('recvPw').value; UI.note('Password set for this transfer.'); };
    id('btnDownload').onclick = function () {
      var r = MD.app.state.receive;
      if (UI.__resultBlob) {
        MD.receive.saveBlob(UI.__resultBlob, UI.__resultName).then(function (res) {
          UI.note('Saved as ' + res.filename + ' via your browser download list.');
        });
        return;
      }
      if (!r.m) { UI.error('Nothing to download yet.'); return; }
      MD.app.state.receive.password = id('recvPw').value;
      id('btnRetry').hidden = true;
      id('btnDownload').disabled = true;
      MD.app.runReceive(r.m);
    };
    id('btnRetry').onclick = function () { id('btnDownload').click(); };
    id('btnDownload').textContent = 'Download & save file';
    id('pasteBox').addEventListener('paste', function () { setTimeout(function () { var v = id('pasteBox').value; if (v && v.length > 30) MD.app.pasteToken(v); }, 60); });

    // settings
    // One handler per control: saving and the follow-up redraw must never
    // overwrite each other (an earlier version did exactly that, silently
    // losing the bucket endpoint on blur).
    function cancelRun() {
    MD.app.cancel();
    UI.warn('Stopping — anything already uploaded will be deleted by the host on its own schedule.');
  }

  function bind(settingKey, elId, transform, after) {
      var el = id(elId);
      var handler = function () {
        var v = transform ? transform(el.value) : el.value;
        if (settingKey.indexOf('.') > 0) {
          var bits = settingKey.split('.');
          MD.app.state.cfg[bits[0]][bits[1]] = v;
        } else MD.app.state.cfg[settingKey] = v;
        MD.app.saveCfg();
        if (after) after();
      };
      el.oninput = handler;
      el.onchange = handler;
      return el;
    }
    id('sBackend').onchange = function () {
      MD.app.state.cfg.backend = this.value;
      id('backendSel').value = this.value;
      MD.app.saveCfg(); fillExpiry(); blurb(); renderPlan(); contextBadges();
    };
    id('sExpiry').onchange = function () { MD.app.state.cfg.expiry = this.value; id('expirySel').value = this.value; MD.app.saveCfg(); renderPlan(); };
    bind('partCapBytes', 'sCap'); bind('receiveBase', 'sReceiveBase');
    var afterBucket = function () { blurb(); contextBadges(); fillProviders(); modeFields(); renderPlan(); };
    bind('s3.endpoint', 'sEp', null, afterBucket);
    bind('s3.bucket', 'sBk', null, afterBucket);
    bind('s3.region', 'sRg', null, afterBucket);
    bind('s3.keyPrefix', 'sPre');
    bind('s3.keyId', 'sKey', null, afterBucket);
    bind('s3.secret', 'sSec', null, afterBucket);
    bind('s3.publicBase', 'sPub');
    bind('s3.signedUrlExpiry', 'sExp2', function (v) { return Number(v) || 86400; });

    id('btnTestBucket').onclick = function () { testBucket(false); };
    id('btnTestReal').onclick = function () { testBucket(true); };

    // The same question the whole Send tab is really asking: can this device reach
    // the host it is about to upload to? Answered with the real upload path, so it
    // covers CORS, form framing and presigning, not just a ping.
    var probe = id('btnProbe');
    if (probe) probe.onclick = function () {
      var out = id('probeOut'), hint = id('probeHint');
      probe.disabled = true;
      out.hidden = false;
      out.textContent = 'checking …';
      hint.textContent = 'working';
      MD.backends.probeHost(MD.app.state.cfg.backend, MD.app.state.cfg.s3).then(function (r) {
        out.textContent = r.lines.join('\n');
        hint.textContent = r.ok ? 'this host works from this device ✓' : 'see the lines above';
      }, function (e) {
        out.textContent = '✗ ' + (e && e.message ? e.message : String(e));
        hint.textContent = 'the check itself failed';
      }).then(function () { probe.disabled = false; });
    };
    id('btnWipe').onclick = function () {
      if (!global.confirm('Forget settings, history and test-mode data in this browser?')) return;
      // Wipe means "this browser keeps nothing about what you sent", and a half
      // finished job is exactly that kind of thing.
      try {
        global.localStorage.removeItem('maildrop.settings.v1');
        global.localStorage.removeItem('maildrop.history.v1');
        global.localStorage.removeItem('maildrop.resume.v1');
      } catch (e) { }
      global.location.href = global.location.pathname;
    };
  }

  function renderHistory() {
    var h = MD.app.history();
    var box = id('histList');
    if (!h.length) { box.textContent = 'nothing yet'; return; }
    box.innerHTML = h.map(function (e, i) {
      return '<div class="fl" style="padding:8px 10px"><div><div class="nm" style="font-size:14px">' + esc(e.n) + '</div>' +
        '<div class="mt">' + U.fmtBytes(e.z) + ' · ' + new Date(e.at).toLocaleString() + '</div></div>' +
        '<button class="btn small ghost" data-re="' + i + '" data-act="copy">copy link</button>' +
        '<button class="btn small ghost" data-re="' + i + '" data-act="open">re-open</button></div>';
    }).join('');
    box.querySelectorAll('[data-re]').forEach(function (b) {
      b.onclick = function () {
        var e = h[Number(b.getAttribute('data-re').trim())];
        if (!e) return;
        if (b.getAttribute('data-act') === 'copy') MD.email.copyText(e.u).then(function () { UI.note('Copied.'); });
        else { tab('receive'); UI.startReceive(MD.email.extract(e.u)); }
      };
    });
  }
  UI.renderHistory = renderHistory;

  function testBucket(real) {
    var cfg = MD.app.state.cfg.s3;
    var bad = MD.backends.selfhost.validateCfg(cfg);
    var out = id('s3out');
    out.hidden = false;
    if (bad.length) { out.textContent = 'Missing: ' + bad.join(', '); id('s3Hint').textContent = 'incomplete'; return; }
    var key = MD.backends.s3.objectKey(cfg, 'selftest.bin');
    MD.backends.s3.presignPutUrl(cfg, key, 1, {}).then(function (signed) {
      var lines = [
        'bucket     ' + cfg.bucket,
        'endpoint   ' + cfg.endpoint,
        'object key ' + key,
        'signed URL ' + signed.url.slice(0, 220) + (signed.url.length > 220 ? '…' : ''),
        'signature  ' + signed.signature.slice(0, 32) + '…'
      ];
      if (!real) {
        lines.push('', 'Config is complete and the request signed. To prove the bucket accepts browser PUTs, use the next button.');
        out.textContent = lines.join('\n');
        id('s3Hint').textContent = 'signed ok';
        return;
      }
      lines.push('', 'uploading 1 byte …');
      out.textContent = lines.join('\n');
      return MD.backends.xhrUpload(signed.url, new Blob([new Uint8Array(1)], { type: 'application/octet-stream' }), { method: 'PUT' })
        .then(function (r) {
          lines.push('✓ HTTP ' + r.status + ' — uploads work. Downloads need no CORS at all (direct link).');
          out.textContent = lines.join('\n');
          id('s3Hint').textContent = 'bucket ok ✓';
          UI.note('Bucket works. You can send parts up to ' + U.fmtBytes(MD.backends.get('selfhost').maxPartBytes) + ' each.');
        })
        .catch(function (e) {
          // Never say "probably CORS" on its own: a refused network and a missing
          // CORS rule look identical to XHR, and the two have different fixes.
          MD.backends.explainFailure(e, cfg, (global.location && global.location.origin) || '').forEach(function (l) {
            lines.push(l);
          });
          out.textContent = lines.join('\n');
          id('s3Hint').textContent = 'failed';
        });
    }).catch(function (e) {
      out.textContent = '✗ ' + e.message;
      id('s3Hint').textContent = 'error';
    });
  }

  function makeDemoFile() {
    var size = 4 * 1024 * 1024;
    var parts = [];
    var made = 0;
    var n = 0;
    while (made < size) {
      var block = '';
      for (var i = 0; i < 2048 && made + block.length < size; i++) {
        var line = 'line ' + (n++) + ' maildrop demo payload filler ' + Math.random().toString(36).slice(2, 10) + '\n';
        block += line;
      }
      parts.push(block);
      made += new Blob([block]).size;
    }
    var blob = new Blob(parts, { type: 'text/plain' });
    if (blob.size > size) blob = blob.slice(0, size);
    var f = new File([blob], 'maildrop-demo.txt', { type: 'text/plain' });
    MD.app.state.files = [f];
    // demo runs against the offline backend so it never needs the network
    MD.app.state.cfg.backend = 'local';
    id('backendSel').value = id('sBackend').value = 'local';
    renderFiles();
    UI.note('4 MB sample staged on the local test backend. Press Start transfer — no network involved.');
  }

  UI.init = function () {
    MD.app.loadCfg();
    fillProviders();
    ['backendSel', 'sBackend'].forEach(function (k) { });
    id('capInput').value = id('sCap').value = MD.app.state.cfg.partCapBytes || '';
    id('sReceiveBase').value = MD.app.state.cfg.receiveBase || '';
    if (id('toInputPre')) id('toInputPre').value = MD.app.state.cfg.mailTo || '';
    if (id('toInput')) id('toInput').value = MD.app.state.cfg.mailTo || '';
    id('pwInput').value = MD.app.state.cfg.password || '';
    id('includeToken').checked = MD.app.state.cfg.includeTokenInMail !== false;
    id('sEp').value = MD.app.state.cfg.s3.endpoint || '';
    id('sBk').value = MD.app.state.cfg.s3.bucket || '';
    id('sRg').value = MD.app.state.cfg.s3.region || '';
    id('sPre').value = MD.app.state.cfg.s3.keyPrefix || '';
    id('sKey').value = MD.app.state.cfg.s3.keyId || '';
    id('sSec').value = MD.app.state.cfg.s3.secret || '';
    id('sPub').value = MD.app.state.cfg.s3.publicBase || '';
    id('sExp2').value = MD.app.state.cfg.s3.signedUrlExpiry || '';
    wire();
    modeFields();
    contextBadges();
    renderHistory();
    renderFiles();
    blurb();
    var opened = MD.app.applyIncomingLink();
    if (!opened) {
      var h = (global.location.hash || '').replace('#', '');
      if (h && h !== 'receive') { /* unknown hash: ignore */ }
    }
    log('s', 'MailDrop ready. Providers: ' + MD.backends.list.map(function (b) { return b.key; }).join(', ') + '.');
    if (!MD.crypto.available()) UI.warn('WebCrypto is off in this context: password protection and checksums are disabled. Use the https:// deployment for those.');
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', UI.init);
  else UI.init();
})(typeof window !== 'undefined' ? window : globalThis);
