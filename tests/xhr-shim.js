'use strict';
/* fetch-backed XMLHttpRequest, shared by the Node test suites: jsdom has no
   fetch and its XHR cannot stream a Blob body, while lib/backends.js is written
   against XHR (needed for upload progress in browsers). Everything else in the
   request path is the shipping code. */
const crypto = require('crypto');

function makeXhr() {
  return function XMLHttpRequest() {
    const self = this;
    self.upload = {};
    self.readyState = 0;
    self.status = 0;
    self.responseText = '';
    let method = 'GET', url = '', headers = {}, timeout = 0;
    self.open = (m, u) => { method = String(m).toUpperCase(); url = u; self.readyState = 1; };
    self.setRequestHeader = (k, v) => { headers[k] = v; };
    self.abort = () => { self._aborted = true; };
    self.send = async (b) => {
      let buf = Buffer.alloc(0);
      try {
        if (b == null) buf = Buffer.alloc(0);
        else if (typeof Blob !== 'undefined' && b instanceof Blob) {
          buf = Buffer.from(await b.arrayBuffer());
          if (b.type && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = b.type;
        } else if (ArrayBuffer.isView(b)) buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
        else if (typeof b === 'string') buf = Buffer.from(b, 'utf8');
        else buf = Buffer.from(String(b));

        if (self.upload.onprogress) self.upload.onprogress({ loaded: Math.floor(buf.length * 0.4), total: buf.length });
        const res = await fetch(url, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' || buf.length === 0 ? undefined : buf
        });
        self.status = res.status;
        self.responseText = await res.text();
        if (self._aborted) { self.onerror && self.onerror(); return; }
        self.onload && self.onload();
      } catch (e) {
        self.status = 0;
        self._error = e;
        self.onerror && self.onerror();
      }
    };
    Object.defineProperty(self, 'timeout', { set: (v) => { timeout = v; }, get: () => timeout });
  };
}

module.exports = { makeXhr };
