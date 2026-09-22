/* MailDrop — the email half. There is no outgoing-mail server (that would break
   the "no server" rule), so the app hands the finished message to the mail
   client you already use: mailto:, the Web Share sheet, or a clipboard copy. */
(function (global) {
  'use strict';
  var MD = (global.MD = global.MD || {});
  var U = MD.util;

  var TOKEN_LINE_BREAK = 60; // safe under 76-char email soft-wrapping

  function tokenLines(token) {
    var out = [];
    for (var i = 0; i < token.length; i += TOKEN_LINE_BREAK) out.push(token.slice(i, i + TOKEN_LINE_BREAK));
    return out.join('\n');
  }

  function subjectFor(m, opts) {
    opts = opts || {};
    var names = m.n ? [m.n] : ['file'];
    var extra = (opts.extraNames || []).length ? ' +' + opts.extraNames.length + ' more' : '';
    return (opts.subjectPrefix ? opts.subjectPrefix : '') +
      'Large file: ' + names[0] + extra + ' (' + U.fmtBytes(m.z) + ') — link inside';
  }

  function hostOf(url) {
    var m2 = /^https?:\/\/([^/]+)/i.exec(String(url || ''));
    return m2 ? m2[1] : 'another host';
  }

  function bodyFor(m, link, opts) {
    opts = opts || {};
    var L = [];
    L.push('Hi,');
    L.push('');
    L.push('The file is too big for an attachment, so it is on a temporary link instead.');
    L.push('Sent with MailDrop — no account, no subscription, nothing installed.');
    L.push('');
    L.push('  ' + (m.z ? U.fmtBytes(m.z) + '  ' : '') + m.n + (m.t ? '  (' + m.t + ')' : ''));
    if (m.d) L.push('  Expires: ' + U.fmtDuration(m.d / 3600000) + ' after the send');
    if (m.f === 'direct') L.push('  Held by: ' + hostOf(m.u || m.b));
    if (m.parts.length > 1) L.push('  Parts: ' + m.parts.length + ' (already stitched into the single link below)');
    if (m.h) L.push('  Integrity: first 8 of SHA-256 = ' + m.h.slice(0, 8));
    if (m.e) L.push('  This one is password protected. I will send the password separately.');
    L.push('');
    if (opts.personal) { L.push(opts.personal, ''); }
    if (m.f === 'direct') {
      L.push('Click it and the download starts:');
      L.push('');
      L.push(m.u || link);
      L.push('');
      L.push('(I sent it with MailDrop, so if you would rather have the file checked and');
      L.push('named properly, open this page instead — it points at the same file:');
      L.push(link);
      L.push('');
    } else {
      L.push('Open this in a browser (phone or laptop, anything modern):');
      L.push('');
      L.push(link);
      L.push('');
    }
    if (opts.includeToken) {
      L.push('If that link does not click, copy everything below (including the next');
      L.push('lines), paste it into the "paste a link or code" box on the MailDrop page,');
      L.push('and press Open.');
      L.push('');
      L.push('CODE');
      L.push(tokenLines(link.indexOf('#') >= 0 ? link.split('#').pop() : ''));
      L.push('END');
      L.push('');
    }
    L.push('The link works until the expiry above, then the file is gone from the host.');
    L.push('');
    L.push('— ' + (opts.from || ''));
    return L.join('\n');
  }

  function mailtoUrl(address, subject, body) {
    var s = U.truncateUtf8(subject || '', 300);
    var b = body || '';
    var prefix = 'mailto:' + (address || '') + '?subject=' + encodeURIComponent(s) + '&body=';
    var budget = 1600 - prefix.length;
    var kept = U.truncateUtf8(b, Math.max(200, budget));
    if (kept !== b) {
      kept += '\n\n(Message shortened for email clients. Full text was too long for a mailto: link — ' +
        'copy the link from the MailDrop page instead.)';
    }
    return prefix + encodeURIComponent(kept);
  }

  function copyText(text) {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      return global.navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  function share(text) {
    if (global.navigator && typeof global.navigator.share === 'function') {
      return global.navigator.share({ title: 'Large file', text: text }).then(function () { return true; }, function () { return false; });
    }
    return Promise.resolve(false);
  }

  // Pull a transfer out of a pasted email — handles the code block, a raw link,
  // or a link that an email client wrapped and quoted-printable-mangled.
  function extract(text) {
    return MD.manifest.findManifest(text);
  }

  function openInClient(address, subject, body) {
    var url = mailtoUrl(address, subject, body);
    try {
      var a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); }, 500);
      return true;
    } catch (e) { return false; }
  }

  MD.email = {
    subjectFor: subjectFor,
    bodyFor: bodyFor,
    mailtoUrl: mailtoUrl,
    copyText: copyText,
    share: share,
    extract: extract,
    openInClient: openInClient,
    tokenLines: tokenLines,
    TOKEN_LINE_BREAK: TOKEN_LINE_BREAK
  };
})(typeof window !== 'undefined' ? window : globalThis);
