/* MailDrop — optional pre-configuration. Everything here is a *starting point*:
   anything the browser already has in its settings (localStorage) wins, and the
   Wipe button in Settings puts you back on these values.

   Written for teams that host the page themselves and want everyone to land on
   the same bucket without filling in a form. Keep secrets out of it — this file
   is part of a public static site, so it is the place for endpoint, bucket,
   region and key id, and never for the key itself. */
(function (global) {
  'use strict';
  var MD = (global.MD = global.MD || {});

  MD.config = {
    // backend: 'selfhost',                    // litterbox | selfhost | direct | local
    // receiveBase: '…the URL this page is published at…',
    // partCapBytes: '64MB',                   // per-part ceiling
    // expiry: '7d',
    // s3: {
    //   endpoint: 's3.eu-central-003.backblazeb2.com',
    //   bucket: 'mail', region: 'eu-central-003', keyPrefix: 'drop/'
    // }
  };
})(typeof window !== 'undefined' ? window : globalThis);
