/* MailDrop P2P — direct browser-to-browser, no host.
   Manual signaling only: copy/paste offer + answer (or QR). No server,
   no signaling, no storage. Both tabs stay open until the file is through.
   Uses a single ordered DataChannel, 16 KiB chunks, backpressure via
   bufferedAmount. The sender builds the archive (zip if several files)
   before the channel opens, so the receiver gets exactly what Send would
   have sent. */
(function(global){
  'use strict';
  var MD = global.MD = global.MD || {};
  var P2P = {};
  MD.p2p = P2P;
  P2P.CHUNK = 16 * 1024;
  P2P.supported = function(){
    return typeof global.RTCPeerConnection !== 'undefined';
  };
  // url-safe base64 without padding, so the code survives mailers that wrap at 76
  function b64urlEncode(s){
    var b = (global.btoa ? global.btoa(s) : Buffer.from(s,'utf8').toString('base64'));
    return b.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function b64urlDecode(s){
    s = String(s).trim().replace(/-/g,'+').replace(/_/g,'/');
    while(s.length % 4) s += '=';
    try{ return global.atob ? global.atob(s) : Buffer.from(s,'base64').toString('utf8'); }
    catch(e){ throw new Error('not a valid code — copy it whole'); }
  }
  function waitGather(pc){
    return new Promise(function(res){
      if(pc.iceGatheringState === 'complete'){ res(); return; }
      function chk(){ if(pc.iceGatheringState === 'complete'){ pc.removeEventListener('icegatheringstatechange', chk); res(); } }
      pc.addEventListener('icegatheringstatechange', chk);
      // gathering can stall behind a NAT; 1.5s is enough for a host+srflx
      setTimeout(function(){ pc.removeEventListener('icegatheringstatechange', chk); res(); }, 1600);
    });
  }
  function encodeDesc(d){ return b64urlEncode(JSON.stringify({t:d.type, s:d.sdp})); }
  function decodeDesc(code){
    var j = JSON.parse(b64urlDecode(String(code).trim()));
    if(!j || !j.t || !j.s) throw new Error('code is not an offer/answer');
    return {type:j.t, sdp:j.s};
  }
  function newPC(){
    var cfg = {iceServers:[{urls:'stun:stun.l.google.com:19302'}]};
    return new global.RTCPeerConnection(cfg);
  }
  // sender: creates offer; caller must keep pc alive and call connectWithAnswer later
  P2P.createOffer = async function(files){
    if(!P2P.supported()) throw new Error('this browser cannot do direct transfers (no WebRTC)');
    var archive = null, fileForChannel = null;
    if(files && files.length > 1){
      try{
        if(MD.pack && MD.pack.makeArchive){
          var made = await MD.pack.makeArchive(files);
          fileForChannel = made;
          archive = true;
        }
      }catch(e){ fileForChannel = files[0]; }
    } else {
      fileForChannel = files && files[0];
    }
    if(!fileForChannel) throw new Error('pick a file first');
    var pc = newPC();
    var dc = pc.createDataChannel('maildrop', {ordered:true});
    // keep references for the connect step
    pc._md_dc = dc;
    pc._md_file = fileForChannel;
    pc._md_archive = archive;
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitGather(pc);
    var code = encodeDesc(pc.localDescription);
    return {code:code, pc:pc, dc:dc, file:fileForChannel};
  };
  P2P.connectWithAnswer = async function(pc, answerCode, onProgress){
    if(!pc || pc.signalingState === 'closed') throw new Error('connection closed — create a new code');
    var desc = decodeDesc(answerCode);
    await pc.setRemoteDescription(desc);
    // wait for connection
    return new Promise(function(resolve, reject){
      var to = setTimeout(function(){ reject(new Error('connection timed out — the answer may be wrong or the network is blocking WebRTC (try a different network)')); }, 20000);
      pc.addEventListener('connectionstatechange', function(){
        if(pc.connectionState === 'connected'){ clearTimeout(to); resolve(); }
        else if(pc.connectionState === 'failed'){ clearTimeout(to); reject(new Error('connection failed — a relay (TURN) would be needed, which MailDrop does not run. Try the host upload instead.')); }
      });
      // also resolve when dc opens
      if(pc._md_dc){
        pc._md_dc.onopen = async function(){
          clearTimeout(to);
          try{ await sendFileOver(pc._md_dc, pc._md_file, onProgress); }catch(e){ reject(e); return; }
          resolve();
        };
        pc._md_dc.onerror = function(e){ clearTimeout(to); reject(new Error('channel error: '+(e && e.message || 'unknown'))); };
      }
    });
  };
  async function sendFileOver(dc, file, onProgress){
    var meta = {n: file.name, s: file.size, t: file.type || 'application/octet-stream', m: file.lastModified || Date.now()};
    // send header as string
    dc.send(JSON.stringify({h:meta}));
    var offset = 0;
    var total = file.size;
    var chunk = P2P.CHUNK;
    // File may be a Blob/File — slice and arrayBuffer
    while(offset < total){
      var end = Math.min(offset+chunk, total);
      var slice = file.slice ? file.slice(offset, end) : file;
      var buf;
      if(slice.arrayBuffer) buf = await slice.arrayBuffer();
      else {
        // fallback via FileReader for older browsers
        buf = await new Promise(function(res, rej){
          var fr = new global.FileReader();
          fr.onload = function(){ res(fr.result); };
          fr.onerror = function(){ rej(new Error('read failed')); };
          fr.readAsArrayBuffer(slice);
        });
      }
      // backpressure
      while(dc.bufferedAmount > 512*1024) await new Promise(function(r){ setTimeout(r, 40); });
      if(dc.readyState !== 'open') throw new Error('channel closed mid-send');
      dc.send(buf);
      offset = end;
      if(onProgress) onProgress(offset, total);
    }
    dc.send(JSON.stringify({e:true}));
  }
  // receiver: takes offer code, returns answer code + sets up receive
  P2P.createAnswer = async function(offerCode, onFile, onProgress){
    if(!P2P.supported()) throw new Error('this browser cannot receive direct transfers');
    var offer = decodeDesc(offerCode);
    var pc = newPC();
    var receivedMeta = null;
    var chunks = [];
    var received = 0;
    var total = 0;
    var doneResolve, doneReject;
    var done = new Promise(function(res, rej){ doneResolve=res; doneReject=rej; });
    pc.ondatachannel = function(ev){
      var dc = ev.channel;
      dc.binaryType = 'arraybuffer';
      dc.onmessage = function(e){
        if(typeof e.data === 'string'){
          try{
            var o = JSON.parse(e.data);
            if(o.h){ receivedMeta = o.h; total = Number(o.h.s)||0; }
            else if(o.e){
              var blob = new Blob(chunks, {type: (receivedMeta && receivedMeta.t) || 'application/octet-stream'});
              // restore name via File
              var file = null;
              try{ file = new File([blob], (receivedMeta && receivedMeta.n) || 'file', {type: blob.type, lastModified: (receivedMeta && receivedMeta.m) || Date.now()}); }
              catch(_){ file = blob; file.name = (receivedMeta && receivedMeta.n) || 'file'; }
              if(onFile) onFile(file, receivedMeta);
              doneResolve({file:file, meta:receivedMeta, bytes:received});
              // keep channel open briefly so sender sees EOF ack
              setTimeout(function(){ try{ dc.close(); }catch(_){} try{ pc.close(); }catch(_){} }, 600);
            }
          }catch(_){}
          return;
        }
        // binary chunk
        chunks.push(e.data);
        received += e.data.byteLength || e.data.size || 0;
        if(onProgress) onProgress(received, total);
      };
      dc.onerror = function(){ doneReject(new Error('channel error')); };
      dc.onclose = function(){ if(received < total) doneReject(new Error('channel closed early — '+received+' of '+total+' bytes')); };
    };
    await pc.setRemoteDescription(offer);
    var answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitGather(pc);
    var code = encodeDesc(pc.localDescription);
    // wait for connection to be established (optional, caller can await done)
    pc.addEventListener('connectionstatechange', function(){
      if(pc.connectionState === 'failed') doneReject(new Error('connection failed'));
    });
    return {code:code, pc:pc, done:done};
  };
  P2P.close = function(pc){
    try{ if(pc && pc._md_dc) try{ pc._md_dc.close(); }catch(_){} }catch(_){}
    try{ if(pc) pc.close(); }catch(_){}
  };
})(typeof window !== 'undefined' ? window : globalThis);
