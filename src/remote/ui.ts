/**
 * The device page, served by the broker as a single self-contained document.
 *
 * Security notes:
 *  - The session key arrives in the URL fragment, which browsers never send to
 *    the server. The broker therefore cannot read it even though it serves this
 *    page. The fragment is stripped from the address bar immediately after use.
 *  - All decryption happens here via WebCrypto. The broker only relays ciphertext.
 *  - CSP forbids every external load, so there is nothing to exfiltrate through.
 */

export const DEVICE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>YIMPIM</title>
<style>
  :root{--bg:#0f1115;--card:#181b22;--line:#262b36;--fg:#e6e9ef;--dim:#98a1b3;
        --ok:#3fb950;--bad:#f85149;--warn:#d29922;--accent:#4f8cff;color-scheme:dark}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       display:flex;flex-direction:column;overflow:hidden}

  /* ---- top bar: brand (mark + wordmark), status pill, stop ---- */
  /* Some mobile browsers report an inflated safe-area-inset-top (accounting
     for their own floating toolbar, not just a real notch/Dynamic Island),
     which turned into a large dead gap above the logo. Capping it keeps
     real notches clear without trusting the browser's number at face value. */
  .topbar{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;
          gap:10px;padding:10px 14px;padding-top:calc(10px + min(env(safe-area-inset-top),24px));
          border-bottom:1px solid var(--line)}
  .brand{display:flex;align-items:center;gap:10px;min-width:0}
  .logo{width:60.8px;height:60.8px;flex:0 0 auto;color:var(--fg)}
  .logo svg{width:100%;height:100%;display:block}
  /* media/yimpim_logo.svg's mark ("Background" group) is reused here with
     its viewBox tightened to that group's own getBBox() (0 0 2392 2013 —
     the full canvas minus the dead space below the mark where the wordmark
     sits in the source file). The source also carries a near-white
     style="fill:#f7f9fa" highlight on one path; dropped here so all three
     paths inherit currentColor uniformly, same theme-adaptivity reasoning
     as the mark this replaced. */
  .wordmark{height:26px;flex:0 0 auto;color:var(--fg)}
  .wordmark svg{height:100%;width:auto;display:block}
  .statuspill{display:inline-flex;align-items:center;flex:0 0 auto;padding:3px 10px;
              border-radius:999px;border:1px solid var(--line);color:var(--dim);
              font-size:11px;font-weight:700;letter-spacing:.04em}
  .statuspill.online{color:var(--ok);border-color:var(--ok)}
  .statuspill.offline{color:var(--bad);border-color:var(--bad)}
  .stopbtn{flex:0 0 auto;width:auto;margin:0;padding:8px 14px;font-size:13px;
           background:var(--bad);border-color:var(--bad);color:#fff;font-weight:600}

  /* ---- compact status strip, collapsible phase list ---- */
  .statusstrip{flex:0 0 auto;padding:8px 14px;border-bottom:1px solid var(--line)}
  .statusrow{display:flex;justify-content:space-between;align-items:baseline;gap:10px;cursor:pointer}
  .statusrow strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
  .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;
        border:1px solid var(--line);color:var(--dim);flex:0 0 auto}
  .pill.run{color:var(--accent);border-color:var(--accent)}
  .pill.ok{color:var(--ok);border-color:var(--ok)}
  .pill.bad{color:var(--bad);border-color:var(--bad)}
  .pill.wait{color:var(--warn);border-color:var(--warn)}
  .dim{color:var(--dim);font-size:13px}
  ul{list-style:none;padding:0;margin:8px 0 0}
  li{padding:6px 0;border-top:1px solid var(--line);display:flex;gap:9px;align-items:flex-start;font-size:13px}
  li:first-child{border-top:0}
  .mark{width:17px;flex:0 0 17px;text-align:center}

  /* ---- console: the largest, tallest section ---- */
  /* Serif for the prose itself — this is read as a report, not watched as a
     raw terminal — with inline \`code\` spans (file/variable/component names)
     kept in monospace and colored, so a name stays visually distinct from
     the sentence around it. */
  .console{flex:1 1 auto;overflow-y:auto;padding:10px 14px;
           font:14px/1.55 Georgia,"Iowan Old Style","Times New Roman",serif;
           color:var(--dim);word-break:break-word}
  .console code{font:12.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent)}
  .logrow{padding:3px 0}
  .logrow-head.tap{cursor:pointer}
  .logrow-head.tap:before{content:'▸ ';color:var(--dim)}
  .logrow.open .logrow-head.tap:before{content:'▾ '}
  /* Prefixed (not a bare .err/.warn) so this never collides with the
     top-level #err pairing-failure banner, which is a totally unrelated
     element that happens to reuse the word "err" as a class name. */
  .logrow-err{color:var(--bad)}
  .logrow-warn{color:var(--warn)}
  .logrow-pending{color:var(--accent)}
  .logrow-busy{opacity:.65;font-style:italic}
  .logrow-body{margin:4px 0 2px 14px;padding:8px 10px;background:#12151c;border-radius:6px;
               word-break:break-word;color:var(--dim)}
  /* One element per reported line, with a HANGING indent: the marker (✓ / ✗ /
     !) sits at the left edge and every wrapped continuation line tucks in
     under it, so a long finding reads as one block belonging to its own
     marker instead of running flush against the next one. */
  .dline{margin:0 0 7px;padding-left:16px;text-indent:-16px;white-space:pre-wrap}
  .dline:last-child{margin:0}
  .dline-ok{color:var(--ok)}
  .dline-bad{color:var(--bad)}
  .dline-warn{color:var(--warn)}
  .dline-head{padding-left:0;text-indent:0;margin-top:12px;color:var(--fg)}
  .dline-head:first-child{margin-top:0}
  /* An ASCII "=====" banner is a terminal-only device — it wraps badly on a
     phone and says nothing a real rule doesn't say better. */
  .logrule{border:0;border-top:1px solid var(--line);margin:10px 0 8px}
  .logrow-shot{display:block;margin:6px 0 2px 14px;max-width:calc(100% - 14px);border-radius:8px}
  .diff-add{color:var(--ok)}
  .diff-del{color:var(--bad)}
  .usage-table{width:100%;border-collapse:collapse;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
  .usage-table th{text-align:left;color:var(--dim);font-weight:600;padding:2px 8px 5px 0;border-bottom:1px solid var(--line)}
  .usage-table td{padding:3px 8px 3px 0;color:var(--fg);white-space:nowrap}
  .usage-table tr.usage-total td{border-top:1px solid var(--line);padding-top:5px;font-weight:600;color:var(--accent)}
  .diffhint{color:var(--accent);font-size:12px;margin-left:4px}

  /* ---- phase/agent grouping in the activity feed ---- */
  .phasehead{margin:14px 0 2px}
  .phasehead .logrow-head{font-weight:700;color:var(--fg);padding:6px 8px;background:#12151c;
                           border-radius:8px;border:1px solid var(--line)}
  .phasehead-goal{font-weight:400;color:var(--dim);font-size:12px;margin-top:3px}
  .agenthead{margin:8px 0 2px 6px;color:var(--dim);font-size:11px;font-weight:700;
             letter-spacing:.06em;text-transform:uppercase}

  /* ---- fullscreen image viewer, tapped open from a screenshot row ---- */
  .lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:50;
            display:flex;align-items:center;justify-content:center;padding:20px}
  .lightbox img{max-width:100%;max-height:100%;border-radius:4px}

  /* ---- diff viewer, tapped open from a patch row ---- */
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50;
         display:flex;align-items:flex-end;justify-content:center}
  .modal-card{background:var(--card);border:1px solid var(--line);border-radius:14px 14px 0 0;
              width:100%;max-height:80vh;display:flex;flex-direction:column}
  .modal-head{display:flex;justify-content:space-between;align-items:center;gap:10px;
              padding:12px 14px;border-bottom:1px solid var(--line);font-weight:600;
              font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
  .modal-head span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .modal-head button{all:unset;cursor:pointer;color:var(--dim);font-size:20px;line-height:1;padding:0 4px;flex:0 0 auto}
  .modal-body{overflow-y:auto;padding:10px 14px calc(10px + min(env(safe-area-inset-bottom),24px));
              font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
  .diffline-add{color:var(--ok);background:rgba(63,185,80,.12)}
  .diffline-del{color:var(--bad);background:rgba(248,81,73,.12)}
  .diffline-ctx{color:var(--dim)}

  /* ---- model settings wizard (reuses .suggest-item's row styling) ---- */
  .modelsearch{margin-bottom:8px}
  .modelback{margin-top:10px;width:100%}
  .modelerr{color:var(--bad);margin-bottom:10px}

  .err{margin:10px 14px 0;padding:10px 12px;border-radius:10px;border:1px solid var(--bad);color:var(--bad);
       background:var(--card);font-size:13px;flex:0 0 auto}

  /* ---- bottom composer ---- */
  .composerwrap{flex:0 0 auto;border-top:1px solid var(--line);background:var(--bg);
                padding:10px 12px calc(10px + min(env(safe-area-inset-bottom),24px))}
  .banner{background:var(--card);border:1px solid var(--warn);color:var(--fg);
          border-radius:10px;padding:8px 10px;margin-bottom:8px;font-size:13px}
  .pillrow{margin-bottom:8px;display:flex}
  .pill.attach{display:inline-flex;align-items:center;gap:6px;background:#1b2030;max-width:100%}
  .pill.attach .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
  .pill.attach button{all:unset;cursor:pointer;color:var(--dim);font-size:16px;line-height:1;padding:0 2px}
  .inputrow{display:flex;align-items:flex-end;gap:8px;position:relative}
  /* Slash-command type-ahead: a tappable list anchored just above the
     composer, filtered as the "/command" token is typed. Manual typing
     still works exactly as before — this is a shortcut, not a replacement. */
  .suggest{position:absolute;left:0;right:0;bottom:100%;margin-bottom:6px;
           background:var(--card);border:1px solid var(--line);border-radius:10px;
           max-height:180px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,.4)}
  .suggest-item{padding:9px 12px;cursor:pointer;display:flex;justify-content:space-between;
                gap:10px;align-items:baseline}
  .suggest-item:active{background:#222734}
  .suggest-item+.suggest-item{border-top:1px solid var(--line)}
  .suggest-item b{color:var(--fg);font:13px ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600}
  .suggest-item span{color:var(--dim);font-size:12px;text-align:right;overflow:hidden;
                      text-overflow:ellipsis;white-space:nowrap;max-width:60%}
  button{font:inherit;border-radius:10px;border:1px solid var(--line);
         background:#222734;color:var(--fg);padding:11px 14px;margin:0}
  button:active{opacity:.7}
  button:disabled{opacity:.4}
  button.go{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  .iconbtn{width:42px;height:42px;flex:0 0 42px;border-radius:50%;padding:0;
           display:flex;align-items:center;justify-content:center;font-size:19px;line-height:1}
  textarea,input:not([type=file]){width:100%;background:#12151c;color:var(--fg);border:1px solid var(--line);
                 border-radius:10px;padding:10px;font:inherit}
  #composer{flex:1 1 auto;margin:0;resize:none;max-height:150px;overflow-y:auto}
  .hide{display:none}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand"><span class="logo"><svg viewBox="0 0 2392 2013" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1917.767,1124.078c9.631,-4.342 20.887,-9.868 31.388,-16.143c331.625,-198.159 229.864,-492.842 52.075,-605.881c-255.526,-162.463 -632.136,-35.256 -782.231,583.4c-63.505,261.751 -34.193,924.435 -34.303,926.889c-0.023,0.519 -404.242,0.735 -404.222,0.28c0.018,-0.41 -8.417,-743.758 -1.412,-805.216c83.059,-728.682 540.021,-1183.905 1022.273,-1127.492c785.781,91.92 832.119,1223.491 -136.208,1290.655c-15.79,1.095 -26.372,-3.951 -25.803,22.812c2.163,101.688 5.593,118.351 -5.289,110.63c-1.454,-1.032 -382.513,-305.029 -384.957,-307.033c0,0 -2.607,-8.656 115.327,-102.931c8.58,-6.858 42.736,-34.162 106.816,-86.201c156.975,-127.477 162.285,-133.935 168.107,-130.049c4.978,3.322 -2.047,106.986 -0.329,120.902c1.788,14.485 51.288,4.325 75.733,0.553c317.875,-49.044 323.379,-374.635 164.676,-475.463c-21.151,-13.438 -0.449,-12.558 2.052,-12.114c291.829,51.806 222.778,449.188 116.535,549.6c-0.575,0.544 -15.866,19.42 -80.229,62.802Z"/><path d="M781.047,903.251c-54.607,205.949 -65.659,365.035 -68.922,373.894c-16.385,44.483 5.842,-63.408 -182.904,-365.858c-96.961,-155.373 -287.631,-359.771 -299.722,-360.446c-8.842,-0.494 -7.285,2.994 -91.775,95.513c-24.885,27.25 -37.654,48.728 -41.795,20.494c-95.976,-654.399 -106.098,-667.794 -89.294,-666.809c6.568,0.385 679.513,133.657 680.686,134.996c1.949,2.224 -144.437,107.126 -139.591,122.082c11.922,36.795 45.869,10.747 284.655,330.887c41.935,56.223 38.189,66.437 35.958,72.517c-28.648,78.103 -35.216,75.291 -87.297,242.73Z"/><path d="M1769.26,272.583c3.318,2.483 -379.997,-59.521 -669.768,575.325c-120.542,264.088 -134.208,528.469 -136.652,575.745c-1.273,24.631 -10.144,-663.333 404.884,-1019.478c177.714,-152.5 394.733,-136.686 401.537,-131.593Z"/></svg></span><span class="wordmark"><svg viewBox="38 2125 2317 444" fill="currentColor" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="YIMPIM"><path d="M211.989,2548.534l0,-170.714l26.121,68.581l-180.451,-301.391l120.823,0l130.019,218.641l-69.815,0l131.001,-218.641l110.861,0l-179.658,301.391l25.319,-68.581l0,170.714l-114.221,0Z" style="fill-rule:nonzero;"/><rect x="504.895" y="2145.01" width="114.221" height="403.524" style="fill-rule:nonzero;"/><path d="M700.316,2548.534l0,-403.524l93.945,0l166.778,274.531l-49.495,0l162.878,-274.531l93.945,0l0.973,403.524l-105.159,0l-0.973,-243.582l17.987,0l-121.535,203.87l-50.648,0l-125.246,-203.87l21.707,0l0,243.582l-105.159,0Z" style="fill-rule:nonzero;"/><path d="M1250.261,2548.534l0,-403.524l184.072,0c36.948,0 68.83,6.002 95.648,18.005c26.824,11.998 47.519,29.192 62.087,51.584c14.574,22.386 21.861,48.903 21.861,79.552c0,30.535 -7.287,56.932 -21.861,79.192c-14.568,22.254 -35.263,39.449 -62.087,51.584c-26.818,12.13 -58.7,18.195 -95.648,18.195l-120.724,0l50.873,-49.819l0,155.231l-114.221,0Zm114.221,-142.747l-50.873,-52.737l114.041,0c23.845,0 41.652,-5.209 53.422,-15.628c11.775,-10.424 17.663,-24.848 17.663,-43.271c0,-18.537 -5.888,-33.014 -17.663,-43.433c-11.769,-10.424 -29.577,-15.637 -53.422,-15.637l-114.041,0l50.873,-52.737l0,223.442Z" style="fill-rule:nonzero;"/><rect x="1669.349" y="2145.01" width="114.221" height="403.524" style="fill-rule:nonzero;"/><path d="M1864.77,2548.534l0,-403.524l93.945,0l166.778,274.531l-49.495,0l162.878,-274.531l93.945,0l0.973,403.524l-105.159,0l-0.973,-243.582l17.987,0l-121.535,203.87l-50.648,0l-125.246,-203.87l21.707,0l0,243.582l-105.159,0Z" style="fill-rule:nonzero;"/></svg></span><span class="statuspill" id="dot">OFFLINE</span></div>
  <button id="abort" class="stopbtn">Stop</button>
</div>

<div id="err" class="err hide"></div>

<div class="statusstrip">
  <div class="statusrow" id="statusrow">
    <strong id="goal">Connecting…</strong>
    <span class="pill" id="state">…</span>
  </div>
  <div class="dim" id="meta"></div>
  <ul id="phases" class="hide"></ul>
</div>

<div class="console" id="log"></div>

<div class="composerwrap">
  <div class="banner hide" id="qbanner"><span id="qtext"></span></div>
  <div class="pillrow hide" id="attachrow">
    <span class="pill attach"><span>📎</span><span class="name" id="attachname"></span>
      <button id="attachx" aria-label="Remove attachment">×</button></span>
  </div>
  <div class="inputrow">
    <div class="suggest hide" id="suggest"></div>
    <button id="plus" class="iconbtn" aria-label="Add a file or image" title="Add a file or image">+</button>
    <textarea id="composer" rows="5" placeholder="Waiting…" disabled></textarea>
    <button id="send" class="iconbtn go" aria-label="Send" disabled>➤</button>
  </div>
  <input type="file" id="afile" hidden accept="image/*,application/pdf,text/plain,text/markdown,application/json">
</div>

<div id="lightbox" class="lightbox hide"><img id="lightboxImg" alt=""></div>

<div id="diffModal" class="modal hide">
  <div class="modal-card">
    <div class="modal-head"><span id="diffTitle"></span><button id="diffClose" aria-label="Close">×</button></div>
    <div class="modal-body" id="diffBody"></div>
  </div>
</div>

<div id="modelModal" class="modal hide">
  <div class="modal-card">
    <div class="modal-head"><span id="modelTitle">Model Settings</span><button id="modelClose" aria-label="Close">×</button></div>
    <div class="modal-body" id="modelBody"></div>
  </div>
</div>

<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var frag=location.hash.slice(1);
  var cfg=null, key=null, token=null, after=-1, seq=0, status=null, stopped=false, pollTimer=null, isOnline=false;
  // Collapsed, tappable activity rows instead of a flat scrolling text blob —
  // phone screen real estate is scarce, and a 2MB attachment or a dozen
  // read_file calls used to mean dozens of near-duplicate lines. Nothing is
  // ever discarded, just folded into a row's detail list until tapped open.
  var rows=[], MAX_LOG_ROWS=300;
  var lookupGroup=null;      // in-progress batch of read/scan/search/outline calls
  var pendingEdits={};       // filename -> its "Editing X…" row, upgraded in place on completion
  var busyText='';           // transient "calling model" indicator — never added to rows[]
  // Replay guard for events, mirroring the desktop's own seenCommands guard
  // for the opposite direction (remote/client.ts) — the broker stores
  // whatever it's POSTed with no dedup by seq, so a batch the desktop
  // retried after an ambiguous network failure (its POST timed out even
  // though the broker had already stored it) lands here twice with the same
  // seq. Same 1000-entry-then-clear approach as the desktop side: this is a
  // safety net for a rare retry, not a real cache, so periodically forgetting
  // old entries is fine.
  var seenEventSeqs={}, seenEventSeqCount=0;
  var screenshotBuffers={};  // id -> {total, mime, label, chunks:{seq:base64}} while a screenshot is still arriving
  var recentEdits={};        // path -> its resolved patch/write row, kept around so a slightly-later
                              // file.changed event (same write, second push) can attach a changeId to it
  var diffBuffers={};        // changeId -> {total, path, chunks:{seq:base64}} while a requested diff is still arriving
  var pendingDiffRequest=null; // changeId the diff modal is currently showing/waiting on
  // Model settings wizard state. modelView is null (closed), 'roles' (the
  // 7-role list), 'primary' or 'backup' (a candidate picker for whichever
  // role/step is in progress) — see openModelModal and renderModelBody.
  var modelView=null, modelRole=null, modelCurrentChain=[], modelChosenPrimary=null, modelConfig=null, modelCatalog=null;
  // 'multi' is the picker for a role that takes a SET of models (the logo designer); modelSelection is what is ticked so far.
  var modelSelection=[], modelInfo=null;
  var currentPhaseId=null, currentAgent=null; // updated from phase.start/worker.start, stamped onto every row
  var collapsedPhases={};    // phaseId -> true once its header has been tapped closed
  // Set once a file is picked, cleared once it's actually transmitted (on
  // Send) or explicitly removed (the × on its pill) — never uploaded in
  // between, so YIMPIM only ever sees it bundled with the message it was
  // meant to go with, and never at all if the user changes their mind.
  var pendingFile=null;
  // Computed fresh in render(): what a tap on Send currently means.
  var mode=null, pendingQid=null;
  // The most recent answer this device actually sent, kept until we know
  // whether it landed — a refusal or a "that question was already resolved"
  // event both arrive asynchronously, well after send() already cleared the
  // composer optimistically, so this is what makes recovering the typed
  // text possible instead of it just being gone.
  var lastSentAnswer=null;

  function fail(m){ $('err').textContent=m; $('err').classList.remove('hide'); }
  function setOnline(on){ isOnline=on; var d=$('dot'); d.className='statuspill '+(on?'online':'offline'); d.textContent=on?'ONLINE':'OFFLINE'; render(); }
  function b64u(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='=';
    var b=atob(s),a=new Uint8Array(b.length); for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i); return a; }
  function b64(a){ var s=''; for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]); return btoa(s); }
  function fromB64(s){ var b=atob(s),a=new Uint8Array(b.length); for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i); return a; }

  // A refresh loses the pairing fragment (it is stripped from the address
  // bar right after first use, see below) and the one-time pairing code
  // itself is single-use server-side, so re-parsing the URL or re-pairing
  // are both dead ends on a reload. localStorage, not sessionStorage: a
  // phone left backgrounded with the screen off for a while can have its tab
  // silently killed and reloaded by the OS to free memory — the page never
  // "closes" from the user's point of view, but sessionStorage is gone all
  // the same, landing back on a bare "scan the QR code" screen with no
  // explanation. localStorage survives that because it's disk-backed, not
  // tied to the tab's process. A stale entry left behind by a session that
  // later expires isn't a real cost: the first reconnect attempt gets a 401,
  // which already clears it and shows "scan a fresh QR code" (see the
  // r.status===401 branch below) — it doesn't sit around silently wrong.
  var STORAGE_KEY='yimpim_session_v1';
  var restoredToken=null;
  try{
    var savedRaw=localStorage.getItem(STORAGE_KEY);
    if(savedRaw){
      var saved=JSON.parse(savedRaw);
      if(saved && saved.sessionId && saved.key && saved.token){
        cfg={sessionId:saved.sessionId, key:saved.key};
        restoredToken=saved.token;
      }
    }
  }catch(e){}

  if(!restoredToken){
    if(!frag){ fail('No pairing data. Scan the QR code shown on your desktop.'); return; }
    // v.sessionId.pairing.key — dot-joined, not JSON. Every byte here was drawn
    // as a QR module, so this page reads it directly instead of via an extra
    // base64 layer. There is no cfg.broker: this page IS the broker's origin.
    var fp=frag.split('.');
    if(fp.length!==4 || fp[0]!=='1'){ fail('Pairing data is unreadable. Re-scan the QR code.'); return; }
    cfg={v:fp[0],sessionId:fp[1],pairing:fp[2],key:fp[3]};
  }

  // Remove the key from the address bar so it is not left in history or shared
  // if the user copies the URL.
  history.replaceState(null,'',location.pathname);

  function aad(sid,s){ return new TextEncoder().encode('1:'+sid+':'+s); }

  function importKey(){
    return crypto.subtle.importKey('raw', b64u(cfg.key), {name:'AES-GCM'}, false, ['encrypt','decrypt']);
  }

  function openEnv(env){
    var iv=fromB64(env.iv), data=fromB64(env.data), tag=fromB64(env.tag);
    var ct=new Uint8Array(data.length+tag.length); ct.set(data); ct.set(tag,data.length);
    return crypto.subtle.decrypt({name:'AES-GCM',iv:iv,additionalData:aad(env.sessionId,env.seq),tagLength:128},key,ct)
      .then(function(pt){ return JSON.parse(new TextDecoder().decode(pt)); });
  }

  function sealCmd(payload){
    var iv=crypto.getRandomValues(new Uint8Array(12));
    var s=seq++;
    var pt=new TextEncoder().encode(JSON.stringify(payload));
    return crypto.subtle.encrypt({name:'AES-GCM',iv:iv,additionalData:aad(cfg.sessionId,s),tagLength:128},key,pt)
      .then(function(buf){
        var all=new Uint8Array(buf);
        return {v:1,sessionId:cfg.sessionId,seq:s,iv:b64(iv),
                data:b64(all.slice(0,all.length-16)),tag:b64(all.slice(all.length-16))};
      });
  }

  function send(verb,extra){
    var payload={id:'c_'+Math.random().toString(36).slice(2),issuedAt:new Date().toISOString(),
                 deviceId:'phone',payload:Object.assign({verb:verb},extra||{})};
    return sealCmd(payload).then(function(env){
      return fetch('/v1/command',{method:'POST',headers:{'content-type':'application/json',
        'authorization':'Bearer '+token},body:JSON.stringify({sessionId:cfg.sessionId,envelope:env}),
        signal:AbortSignal.timeout(15000)});
    });
  }

  // Files are chunked so each command stays a normal small envelope, and every
  // chunk is sealed with the session key like any other command — the relay
  // sees ciphertext only, exactly as it does for a stop or an answer.
  var CHUNK=48*1024, MAX=10*1024*1024;

  // Distinct from b64() above: that one is for short envelope fields, this
  // walks a file in slices so a large buffer cannot blow the argument limit.
  function b64chunk(bytes){
    var s='', CH=0x8000;
    for(var i=0;i<bytes.length;i+=CH){ s+=String.fromCharCode.apply(null,bytes.subarray(i,i+CH)); }
    return btoa(s);
  }

  var MAX_IMAGE_DIM=1600;
  // A phone camera photo costs more than it needs to, twice over: more
  // chunks to upload (48KB each, strictly sequential) and more tokens once a
  // vision model tiles it by resolution. Neither needs full camera
  // resolution to judge whether a button looks right, so this downscales to
  // a size that is still plenty sharp for that and re-encodes as JPEG.
  // Falls back to the original bytes untouched if decoding fails for any
  // reason (unsupported format, very old browser) rather than blocking the
  // attachment outright.
  function downscaleImage(file){
    return createImageBitmap(file).then(function(bitmap){
      var w=bitmap.width, h=bitmap.height;
      var scale=Math.min(1, MAX_IMAGE_DIM/Math.max(w,h));
      if(scale>=1){
        if(bitmap.close) bitmap.close();
        return file.arrayBuffer().then(function(buf){ return {bytes:new Uint8Array(buf), mime:file.type||'application/octet-stream'}; });
      }
      var cw=Math.max(1,Math.round(w*scale)), ch=Math.max(1,Math.round(h*scale));
      var canvas=document.createElement('canvas');
      canvas.width=cw; canvas.height=ch;
      var ctx=canvas.getContext('2d');
      ctx.drawImage(bitmap,0,0,cw,ch);
      if(bitmap.close) bitmap.close();
      return new Promise(function(resolve,reject){
        canvas.toBlob(function(blob){
          if(!blob){ reject(new Error('could not encode downscaled image')); return; }
          blob.arrayBuffer().then(function(buf){ resolve({bytes:new Uint8Array(buf), mime:'image/jpeg'}); }).catch(reject);
        },'image/jpeg',0.85);
      });
    }).catch(function(){
      return file.arrayBuffer().then(function(buf){ return {bytes:new Uint8Array(buf), mime:file.type||'application/octet-stream'}; });
    });
  }

  /** Transmits a staged file now. Resolves once every chunk is confirmed sent. */
  // 'file' here is {name, mime, bytes} — already read into memory at pick
  // time (see afile.onchange below), deliberately not a live File object.
  // A File's underlying OS-backed handle can go stale between picking it and
  // pressing Send (seen in the wild on iOS Safari, especially after
  // backgrounding the tab to use the picker itself) — reading it at that
  // point throws "A requested file or directory could not be found at the
  // time an operation was processed" with no way to recover except re-picking.
  // Reading the bytes up front means Send never touches the File object at
  // all, so there is nothing left that can go stale out from under it.
  function uploadFile(file){
    note('→ sending '+file.name+' ('+Math.round(file.bytes.length/1024)+' KB)…');
    var bytes=file.bytes;
    var total=Math.max(1,Math.ceil(bytes.length/CHUNK));
    var uploadId='u_'+Math.random().toString(36).slice(2);

    // Strictly sequential: chunks must not race each other onto the relay.
    var chain=Promise.resolve();
    for(var i=0;i<total;i++){
      (function(seqNo){
        chain=chain.then(function(){
          return send('attach',{uploadId:uploadId,name:file.name,mime:file.mime,
                                seq:seqNo,total:total,
                                data:b64chunk(bytes.subarray(seqNo*CHUNK,(seqNo+1)*CHUNK))});
        }).then(function(){
          if(total>1) $('send').textContent=Math.round((seqNo+1)/total*100)+'%';
        });
      })(i);
    }
    return chain.then(function(){
      $('send').textContent='➤';
      note('✓ '+file.name+' sent');
    }).catch(function(e){
      $('send').textContent='➤';
      note('✗ upload failed: '+e.message,'error');
      throw e;
    });
  }

  function phaseSummary(){
    var phases=status&&status.phases||[];
    if(!phases.length) return '';
    var done=phases.filter(function(p){return p.status==='passed'}).length;
    return done+'/'+phases.length+' phases';
  }

  function render(){
    // Independent of status having arrived yet: as soon as the connection
    // itself is up, the phone can compose a message (see the mode logic
    // below) — waiting on a first status event would mean the earliest
    // moments after pairing look identical to genuinely being stuck offline.
    var q=status&&(status.pendingQuestions||[])[0];
    if(q){
      mode='answer'; pendingQid=q.id;
      $('qbanner').classList.remove('hide'); $('qtext').textContent=q.prompt;
      $('composer').placeholder='Type your answer…';
    } else {
      // No question outstanding right now — this is also how a run gets
      // STARTED from the phone: the desktop keeps a real question open the
      // instant it's idle ("what should I do?"), so this only reads as
      // "message" while the desktop is actively mid-task. Sent either way —
      // it's applied the moment the desktop next asks anything.
      mode='message'; pendingQid=null;
      $('qbanner').classList.add('hide');
      $('composer').placeholder=isOnline?'Type an instruction…':'Waiting to connect…';
    }
    $('composer').disabled=!isOnline;
    updateSendEnabled();
    updateSuggest();

    if(!status) return;
    $('goal').textContent=status.goal||status.repoName||'Waiting for plan…';
    var metaBits=[status.repoName,phaseSummary(),
                  status.tokensUsed?status.tokensUsed.toLocaleString()+' tokens':''].filter(Boolean);
    $('meta').textContent=metaBits.join('  ·  ');
    var p=$('state'); p.textContent=status.state;
    p.className='pill '+(status.state==='done'?'ok':status.state==='failed'||status.state==='aborted'?'bad':
                         status.state==='awaiting-input'?'wait':'run');

    $('phases').innerHTML='';
    (status.phases||[]).forEach(function(ph){
      var li=document.createElement('li');
      var m=ph.status==='passed'?'✓':ph.status==='failed'?'✗':ph.status==='running'?'▶':'·';
      li.innerHTML='<span class="mark">'+m+'</span><span>'+ph.name.replace(/[<&]/g,'')+'</span>';
      $('phases').appendChild(li);
    });

  }

  // Curated to match what's actually useful from a phone — no /api-key
  // (rotates a desktop-stored secret) or the numeric-menu commands.
  var SLASH_COMMANDS=[
    {cmd:'/remote-control',desc:'Pair a phone'},
    {cmd:'/model',desc:'Change model'},
    {cmd:'/status',desc:'Models & readiness'},
    {cmd:'/plan',desc:'Current plan'},
    {cmd:'/push-repo',desc:'Connect & push to GitHub'},
    {cmd:'/push-local',desc:'Commit pending & stay local'},
    {cmd:'/branch',desc:'Create/switch branch'},
    {cmd:'/branches',desc:'List branches'},
    {cmd:'/merge',desc:'Merge into default branch'},
    {cmd:'/memory',desc:'What YIMPIM has learned'},
    {cmd:'/ask',desc:'Ask, read-only'},
    {cmd:'/help',desc:'Command list'},
    {cmd:'/exit',desc:'Quit'}
  ];

  // Tappable shortcut for the commands above — never required, manual typing
  // of the full command still works exactly as before. Only offered while
  // the field is still just "/" plus the command token itself; a space means
  // the user has moved on to an argument (e.g. "/ask " + a question) and
  // there's nothing left to suggest.
  function updateSuggest(){
    var box=$('suggest');
    var text=$('composer').value;
    var m=/^\\/(\\S*)$/.exec(text);
    var matches=(mode && m) ? SLASH_COMMANDS.filter(function(c){ return c.cmd.indexOf(text.toLowerCase())===0; }) : [];
    box.innerHTML='';
    if(matches.length===0){ box.classList.add('hide'); return; }
    matches.forEach(function(c){
      var row=document.createElement('div');
      row.className='suggest-item';
      var b=document.createElement('b'); b.textContent=c.cmd;
      var s=document.createElement('span'); s.textContent=c.desc;
      row.appendChild(b); row.appendChild(s);
      // Prevent the textarea from losing focus (which would dismiss the
      // on-screen keyboard) before the click handler below can run.
      row.onmousedown=function(e){ e.preventDefault(); };
      row.onclick=function(){
        box.classList.add('hide'); box.innerHTML='';
        // /model opens the wizard directly — there's nothing further to type,
        // unlike every other suggestion here (which still needs Send pressed,
        // possibly after an argument).
        if(c.cmd==='/model'){ $('composer').value=''; updateSendEnabled(); openModelModal(); return; }
        $('composer').value=c.cmd+' ';
        $('composer').focus();
        updateSendEnabled();
      };
      box.appendChild(row);
    });
    box.classList.remove('hide');
  }

  function updateSendEnabled(){
    // Answering with nothing typed is valid — it accepts the question's own
    // default. A free-form message needs actual text, since there's no
    // question providing a default for it to fall back on.
    $('send').disabled = mode==='answer' ? false : !$('composer').value.trim();
  }

  // Oldest-to-newest, appended at the bottom, like every terminal and log
  // viewer — auto-scroll only happens when the viewer was already at (or
  // very near) the bottom, so someone reading history keeps their place
  // while updates keep arriving quietly below, and returning to the bottom
  // resumes auto-follow.
  function renderLog(){
    var el=$('log');
    var nearBottom=(el.scrollHeight-el.scrollTop-el.clientHeight)<40;
    el.innerHTML='';
    rows.forEach(function(row){
      if(row.rule){ el.appendChild(document.createElement('hr')).className='logrule'; return; }
      // A phase header renders unconditionally (it's the toggle for its own
      // group) — everything else belonging to a collapsed phase is skipped
      // entirely rather than just visually hidden, so a very long phase never
      // costs anything once its header is tapped closed.
      if(row.phaseHeader){
        var open=!collapsedPhases[row.phaseId];
        var pdiv=document.createElement('div');
        pdiv.className='logrow phasehead'+(open?' open':'');
        var phead=document.createElement('div');
        phead.className='logrow-head tap';
        phead.innerHTML=richTextToHtml(row.summary)+(row.goal?'<div class="phasehead-goal">'+richTextToHtml(row.goal)+'</div>':'');
        phead.onclick=(function(pid){ return function(){ collapsedPhases[pid]=!collapsedPhases[pid]; renderLog(); }; })(row.phaseId);
        pdiv.appendChild(phead);
        el.appendChild(pdiv);
        return;
      }
      if(collapsedPhases[row.phaseId]) return;
      if(row.agentHeader){
        var adiv=document.createElement('div');
        adiv.className='agenthead';
        adiv.textContent=row.summary;
        el.appendChild(adiv);
        return;
      }
      var div=document.createElement('div');
      div.className='logrow'+(row.status==='error'?' logrow-err':row.status==='warn'?' logrow-warn':row.status==='pending'?' logrow-pending':'')
        +(row.expanded?' open':'');
      var head=document.createElement('div');
      head.className='logrow-head'+(row.expandable||row.diffChangeId?' tap':'');
      // row.html is pre-built markup from a caller that already escaped and
      // colored its own pieces (e.g. the patch-stat +N/-M spans below) —
      // passing it back through richTextToHtml would just escape those tags
      // into visible text.
      head.innerHTML=row.html!==undefined?row.html:richTextToHtml(row.summary);
      if(row.expandable){
        head.onclick=function(){ row.expanded=!row.expanded; renderLog(); };
      } else if(row.diffChangeId){
        head.onclick=(function(id,p){ return function(){ openDiff(id,p); }; })(row.diffChangeId,row.diffPath);
      }
      div.appendChild(head);
      if(row.expandable && row.expanded){
        var body=document.createElement('div');
        body.className='logrow-body';
        if(row.bodyHtml!==undefined){
          // Pre-built markup (the token-usage table below) — already escaped
          // by its own builder, so this bypasses the per-line dline treatment.
          body.innerHTML=row.bodyHtml;
        } else {
        // One element per line rather than one pre-wrap blob: a QA finding
        // routinely wraps to four or five lines on a phone, and as a single
        // blob every one of those wrapped lines started hard against the left
        // edge — indistinguishable from the start of the NEXT finding. Each
        // line now carries its own hanging indent and spacing, and takes its
        // color from its own marker.
        row.detail.forEach(function(line){
          var t=line.replace(/^\\s+/,'');
          // A rule or heading embedded mid-message (Advisor prose using real
          // markdown, e.g. "---" between sections or "### Why this matters")
          // — not just a whole banner message, which the separator check
          // higher up in ingestRemote already handles on its own.
          if(/^(-{3,}|\\*{3,})\\s*$/.test(t)){
            body.appendChild(document.createElement('hr')).className='logrule';
            return;
          }
          var heading=t.match(/^#{1,6}\\s+(.+)$/);
          var d=document.createElement('div');
          if(heading){
            d.className='dline dline-head';
            d.innerHTML='<b>'+richTextToHtml(heading[1])+'</b>';
          } else {
            d.className='dline'+(/^[✓✔]/.test(t)?' dline-ok':/^[✗✘❌]/.test(t)?' dline-bad':/^[!?⚠]/.test(t)?' dline-warn':'');
            d.innerHTML=richTextToHtml(line);
          }
          body.appendChild(d);
        });
        }
        div.appendChild(body);
      }
      if(row.image){
        var img=document.createElement('img');
        img.src=row.image;
        img.className='logrow-shot';
        img.loading='lazy';
        img.onclick=(function(src){ return function(e){ e.stopPropagation(); openLightbox(src); }; })(row.image);
        div.appendChild(img);
      }
      el.appendChild(div);
    });
    if(busyText){
      var b=document.createElement('div');
      b.className='logrow logrow-busy';
      b.textContent=busyText;
      el.appendChild(b);
    }
    if(nearBottom) el.scrollTop=el.scrollHeight;
  }

  function addRow(row){
    if(row.phaseId===undefined) row.phaseId=currentPhaseId;
    rows.push(row);
    if(rows.length>MAX_LOG_ROWS) rows.shift();
    renderLog();
    return row;
  }

  function openLightbox(src){
    $('lightboxImg').src=src;
    $('lightbox').classList.remove('hide');
  }
  function closeLightbox(){
    $('lightbox').classList.add('hide');
    $('lightboxImg').src='';
  }

  function openDiff(changeId,path){
    pendingDiffRequest=changeId;
    $('diffTitle').textContent=path||'';
    $('diffBody').textContent='Loading diff…';
    $('diffModal').classList.remove('hide');
    send('fetch_diff',{changeId:changeId}).catch(function(){
      if(pendingDiffRequest===changeId){ $('diffBody').textContent='Could not request the diff — check your connection.'; }
    });
  }
  function closeDiffModal(){
    $('diffModal').classList.add('hide');
    pendingDiffRequest=null;
  }

  // ---- model settings wizard --------------------------------------------
  // Three views inside one modal, matching /model's own desktop flow: a role
  // list, then a primary-model picker, then a backup-model picker (skippable).
  // Everything renders through renderModelBody() off the state vars declared
  // above, the same "one render function reads plain state" shape render()
  // itself already uses for the status strip.

  var ROLE_LABELS={discovery:'Discovery',discoveryVision:'Discovery (Vision)',planner:'Planner',
                    editor:'Editor',editorVision:'Editor (Vision)',repair:'Repair',repairVision:'Repair (Vision)',
                    verifier:'Verifier',verifierVision:'Verifier (Vision)'};
  var ROLE_ORDER=['discovery','discoveryVision','planner','editor','editorVision','repair','repairVision','verifier','verifierVision'];
  // Mirrors PERSONAS' own optional flag (src/models.ts) — these are the only
  // roles /model (and this wizard) ever lets go back to unset.
  var OPTIONAL_ROLES={discoveryVision:true,editorVision:true,repair:true,repairVision:true,verifierVision:true};
  // The desktop sends what each role is (label, optional, multi-select) with model.config, so a role added there
  // appears here without a change; the lists above are only the fallback for an older desktop.
  function roleList(){
    if(modelInfo&&modelInfo.length){ return modelInfo; }
    return ROLE_ORDER.map(function(r){ return {role:r,label:ROLE_LABELS[r],optional:!!OPTIONAL_ROLES[r],multi:null,blurb:''}; });
  }
  function infoFor(role){
    var l=roleList();
    for(var i=0;i<l.length;i++){ if(l[i].role===role){ return l[i]; } }
    return {role:role,label:ROLE_LABELS[role]||role,optional:!!OPTIONAL_ROLES[role],multi:null,blurb:''};
  }

  function openModelModal(){
    modelView='roles'; modelConfig=null; modelRole=null; modelChosenPrimary=null; modelCatalog=null;
    $('modelModal').classList.remove('hide');
    renderModelBody();
    send('get_model_config').catch(function(){
      if(modelView) renderModelError('Could not request model config — check your connection.');
    });
  }
  function closeModelModal(){
    $('modelModal').classList.add('hide');
    modelView=null; modelRole=null; modelChosenPrimary=null; modelCatalog=null;
  }

  function openPrimaryPicker(role,currentChain){
    modelRole=role; modelCurrentChain=currentChain||[]; modelChosenPrimary=null; modelCatalog=null;
    if(infoFor(role).multi){
      modelView='multi'; modelSelection=modelCurrentChain.slice();
      renderModelBody();
      send('list_models',{role:role}).catch(function(){
        if(modelView==='multi') renderModelError('Could not request models — check your connection.');
      });
      return;
    }
    modelView='primary';
    renderModelBody();
    send('list_models',{role:role}).catch(function(){
      if(modelView==='primary') renderModelError('Could not request models — check your connection.');
    });
  }

  function openBackupPicker(){
    modelCatalog=null; modelView='backup';
    renderModelBody();
    send('list_models',{role:modelRole,exclude:[modelChosenPrimary]}).catch(function(){
      if(modelView==='backup') renderModelError('Could not request models — check your connection.');
    });
  }

  /** Persists a chain (0-2 entries) for the role currently in progress. */
  function submitModel(chain){
    $('modelTitle').textContent=infoFor(modelRole).label;
    var body=$('modelBody'); body.innerHTML=''; body.textContent='Saving…';
    send('set_model',{role:modelRole,chain:chain}).catch(function(){
      if(modelView) renderModelError('Could not send — check your connection.');
    });
  }

  function formatModelMeta(m){
    var cost=m.isVariablePrice?'variable price':m.isFree?'free':
      ('$'+m.pricing.promptPerM.toFixed(2)+'/$'+m.pricing.completionPerM.toFixed(2)+' per M in/out');
    var ctx=m.contextLength>=1000?Math.round(m.contextLength/1000)+'k ctx':m.contextLength+' ctx';
    return cost+', '+ctx;
  }

  function addModelBackButton(body){
    var back=document.createElement('button');
    back.className='modelback';
    back.textContent=modelView==='backup'?'‹ Back to primary':(modelView==='primary'||modelView==='multi')?'‹ Back to roles':'‹ Back';
    back.onclick=function(){
      if(modelView==='backup'){ openPrimaryPicker(modelRole,modelCurrentChain); }
      else{ modelView='roles'; renderModelBody(); }
    };
    body.appendChild(back);
  }

  function renderModelError(msg){
    var body=$('modelBody'); body.innerHTML='';
    var p=document.createElement('div'); p.className='modelerr'; p.textContent=msg;
    body.appendChild(p);
    addModelBackButton(body);
  }

  function renderModelRoles(body){
    $('modelTitle').textContent='Model Settings';
    if(!modelConfig){ body.textContent='Loading…'; return; }
    var byRole={};
    modelConfig.forEach(function(r){ byRole[r.role]=r.chain||[]; });
    roleList().forEach(function(info){
      var role=info.role;
      var chain=byRole[role]||[];
      var row=document.createElement('div');
      row.className='suggest-item';
      var b=document.createElement('b'); b.textContent=info.label+(info.multi?' (set)':'');
      var s=document.createElement('span'); s.textContent=chain.length?chain.join('  →  '):'not set';
      row.appendChild(b); row.appendChild(s);
      row.onclick=function(){ openPrimaryPicker(role,chain); };
      body.appendChild(row);
    });
  }

  function renderModelCatalogPicker(body){
    var multi=modelView==='multi';
    var info=infoFor(modelRole);
    $('modelTitle').textContent=info.label+(multi?'':(modelView==='backup'?' — backup':' — primary'));
    if(modelCatalog===null){ body.textContent='Loading models…'; addModelBackButton(body); return; }
    var summary=null;
    if(multi){
      var max=info.multi?info.multi.max:6;
      if(info.blurb){ var bl=document.createElement('div'); bl.className='modelerr'; bl.style.opacity='.8'; bl.textContent=info.blurb; body.appendChild(bl); }
      summary=document.createElement('div'); summary.className='suggest-item';
      body.appendChild(summary);
      var save=document.createElement('button'); save.className='modelback'; save.textContent='Save';
      save.onclick=function(){ if(modelSelection.length>=1){ submitModel(modelSelection); } };
      body.appendChild(save);
      if(info.optional&&modelCurrentChain.length>0){
        var clr=document.createElement('button'); clr.className='modelback'; clr.textContent='Unset (back to default)';
        clr.onclick=function(){ submitModel([]); };
        body.appendChild(clr);
      }
      var refreshSummary=function(){
        summary.innerHTML='';
        var sb=document.createElement('b'); sb.textContent='Selected '+modelSelection.length+' of up to '+max;
        var ss=document.createElement('span'); ss.textContent=modelSelection.length?modelSelection.join(', '):'tap models below to add or remove';
        summary.appendChild(sb); summary.appendChild(ss);
        save.disabled=modelSelection.length<1;
      };
      refreshSummary();
    }

    var search=document.createElement('input');
    search.className='modelsearch';
    search.placeholder='Search models…';
    body.appendChild(search);
    var list=document.createElement('div');
    body.appendChild(list);

    function renderList(){
      list.innerHTML='';
      var term=search.value.trim().toLowerCase();
      var items=term?modelCatalog.filter(function(m){ return m.id.toLowerCase().indexOf(term)!==-1; }):modelCatalog;

      if(multi){
        // no extra rows: the selection summary above is the control
      } else if(modelView==='backup'){
        var none=document.createElement('div');
        none.className='suggest-item';
        var b=document.createElement('b'); b.textContent='No backup';
        var s=document.createElement('span'); s.textContent='primary only';
        none.appendChild(b); none.appendChild(s);
        none.onclick=function(){ submitModel([modelChosenPrimary]); };
        list.appendChild(none);
      } else if(info.optional && modelCurrentChain.length>0){
        var unset=document.createElement('div');
        unset.className='suggest-item';
        var ub=document.createElement('b'); ub.textContent='Unset';
        var us=document.createElement('span'); us.textContent='back to default';
        unset.appendChild(ub); unset.appendChild(us);
        unset.onclick=function(){ submitModel([]); };
        list.appendChild(unset);
      }

      // Capped rather than rendering every match — search narrows it down;
      // this just guards against a wide-open filter briefly reflowing a
      // multi-hundred-row list.
      items.slice(0,80).forEach(function(m){
        var row=document.createElement('div');
        row.className='suggest-item';
        var picked=multi&&modelSelection.indexOf(m.id)!==-1;
        var b=document.createElement('b'); b.textContent=(picked?'✓ ':'')+m.id;
        var s=document.createElement('span'); s.textContent=formatModelMeta(m);
        row.appendChild(b); row.appendChild(s);
        row.onclick=function(){
          if(multi){
            var at=modelSelection.indexOf(m.id);
            if(at!==-1){ modelSelection.splice(at,1); }
            else if(modelSelection.length<(info.multi?info.multi.max:6)){ modelSelection.push(m.id); }
            renderList(); refreshSummary();
            return;
          }
          if(modelView==='primary'){ modelChosenPrimary=m.id; openBackupPicker(); }
          else{ submitModel([modelChosenPrimary,m.id]); }
        };
        list.appendChild(row);
      });
    }
    search.oninput=renderList;
    renderList();
    addModelBackButton(body);
  }

  function renderModelBody(){
    var body=$('modelBody');
    body.innerHTML='';
    if(modelView==='roles') renderModelRoles(body);
    else if(modelView==='primary'||modelView==='backup'||modelView==='multi') renderModelCatalogPicker(body);
  }

  function b64ToUtf8(b64){
    var bin=atob(b64), bytes=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++){ bytes[i]=bin.charCodeAt(i); }
    return new TextDecoder().decode(bytes);
  }

  function renderDiffBody(text){
    var body=$('diffBody');
    body.innerHTML='';
    text.split('\\n').forEach(function(line){
      var d=document.createElement('div');
      var prefix=line.charAt(0);
      d.className=prefix==='+'?'diffline-add':prefix==='-'?'diffline-del':'diffline-ctx';
      d.textContent=line;
      body.appendChild(d);
    });
  }

  /**
   * Reassembles one diff from base64 chunks, keyed by changeId, the same
   * pattern as ingestScreenshotChunk below — a full-file rewrite's diff can
   * just as easily exceed one envelope as a screenshot can.
   */
  function ingestDiffChunk(ev){
    var buf=diffBuffers[ev.changeId];
    if(!buf){ buf=diffBuffers[ev.changeId]={total:ev.total,path:ev.path,chunks:{}}; }
    buf.chunks[ev.seq]=ev.data;
    if(Object.keys(buf.chunks).length<buf.total) return;
    var parts=[]; for(var i=0;i<buf.total;i++){ parts.push(buf.chunks[i]); }
    delete diffBuffers[ev.changeId];
    if(ev.changeId===pendingDiffRequest){ renderDiffBody(b64ToUtf8(parts.join(''))); }
  }

  /** Dispatches one decrypted wire event. Named (not inline) so it's directly unit-testable — see test/deviceUi.test.ts. */
  function handleEvent(ev){
    if(ev.kind==='status'){ status=ev.status; render(); }
    else if(ev.kind==='session.end'){ note('session ended: '+ev.reason,'warn'); stopped=true; clearSavedSession(); }
    else if(ev.kind==='log'){ ingestRemote(ev.message,ev.level); }
    else if(ev.kind==='screenshot.chunk'){ ingestScreenshotChunk(ev); }
    else if(ev.kind==='command.refused'){
      // set_model's own refusal (task running, a required role left empty, …)
      // belongs inside the wizard that asked for it, not the composer-restore
      // handling every other refused verb gets.
      if(ev.verb==='set_model' && modelView){ renderModelError(ev.reason||'"set_model" was refused.'); }
      else{ handleSendRejected(ev.reason||('"'+ev.verb+'" is not enabled for this run')); }
    }
    else if(ev.kind==='answer.rejected'){ handleSendRejected(ev.reason||'that question was already resolved',ev.questionId); }
    else if(ev.kind==='diff.chunk'){ ingestDiffChunk(ev); }
    else if(ev.kind==='diff.unavailable'){ if(ev.changeId===pendingDiffRequest){ $('diffBody').textContent='This change is no longer available.'; } }
    else if(ev.kind==='model.config'){
      modelConfig=ev.roles;
      if(ev.roleInfo&&ev.roleInfo.length){ modelInfo=ev.roleInfo; }
      // Arrives both for the initial get_model_config AND right after a
      // successful set_model — either way, land back on the role list with
      // fresh data rather than trusting an optimistic local update.
      if(modelView){ modelView='roles'; modelRole=null; modelChosenPrimary=null; modelCatalog=null; renderModelBody(); }
    }
    else if(ev.kind==='model.catalog'){
      if((modelView==='primary'||modelView==='backup'||modelView==='multi') && ev.role===modelRole){ modelCatalog=ev.models; renderModelBody(); }
    }
    else if(ev.kind==='model.catalog_unavailable'){
      if((modelView==='primary'||modelView==='backup'||modelView==='multi') && ev.role===modelRole){ renderModelError(ev.reason||'Could not load models for this role.'); }
    }
    else if(ev.kind==='phase.start'){
      closeLookupGroup();
      currentPhaseId=ev.phaseId; currentAgent=null;
      addRow({phaseHeader:true,phaseId:ev.phaseId,summary:'Phase '+(ev.index+1)+'/'+ev.total+': **'+ev.name+'**',goal:ev.goal});
    }
    else if(ev.kind==='task.start'){
      // The prompt that started the task, typed at the desktop or sent from a
      // phone: without this row a task typed on the desktop begins with no
      // trace of what was asked, only the agent's replies to it.
      closeLookupGroup();
      var promptText=String(ev.prompt||'').trim();
      if(promptText){
        var promptLines=promptText.split('\\n').filter(function(l){return l.trim().length>0;});
        var promptHead=promptLines.shift()||'';
        var longHead=promptHead.length>220;
        var promptDetail=(longHead?[promptHead]:[]).concat(promptLines);
        var attached=(ev.attachments&&ev.attachments.length)?' ('+ev.attachments.length+' attached)':'';
        addRow({summary:'🧑 **You:** '+(longHead?promptHead.slice(0,220)+'…':promptHead)+attached,detail:promptDetail,expandable:promptDetail.length>0,expanded:false,status:'done'});
      }
    }
    else if(ev.kind==='phase.end'){ /* the next phase.start's header (or run end) speaks for it — no separate row */ }
    else if(ev.kind==='worker.end'){ /* the next worker.start's header speaks for it — no separate row */ }
    else if(ev.kind==='worker.start'){
      if(ev.phaseId && ev.phaseId!==currentPhaseId){
        currentPhaseId=ev.phaseId; currentAgent=null;
        addRow({phaseHeader:true,phaseId:ev.phaseId,summary:ev.phaseName||ev.phaseId});
      }
      if(ev.agent!==currentAgent){
        closeLookupGroup();
        currentAgent=ev.agent;
        addRow({agentHeader:true,summary:ev.agent});
      }
    }
    else if(ev.kind==='file.changed'){
      var editedRow=recentEdits[ev.path];
      if(editedRow && ev.changeId){
        editedRow.diffChangeId=ev.changeId;
        editedRow.diffPath=ev.path;
        if(editedRow.html!==undefined && editedRow.html.indexOf('diffhint')===-1){
          editedRow.html+=' <span class="diffhint">view diff \\u203a</span>';
        }
        renderLog();
      }
    }
    else note(ev.kind+(ev.name?' · '+ev.name:'')+(ev.detail?' · '+ev.detail:''));
  }

  /** One-off local UI feedback (upload progress, send result) — always its own row. */
  function note(text,status){
    closeLookupGroup();
    addRow({summary:text,detail:[],expandable:false,status:status||'done'});
  }

  /**
   * A message this device just sent never actually landed — either the verb
   * itself was refused, or (more commonly, for an "answer") the question it
   * targeted had already been resolved some other way before this arrived.
   * Both used to just vanish: send() clears the composer optimistically the
   * moment the broker accepts the upload, well before either failure can be
   * known, so the typed text was gone with nothing on screen explaining why.
   * Surfaced here as an unmistakable warning row, and the text is restored
   * into the composer (only if nothing new has been typed since) so fixing
   * and resending doesn't mean retyping from memory.
   */
  function handleSendRejected(why, questionId){
    closeLookupGroup();
    addRow({summary:'⚠️ Your last message was not used — '+why+'.',detail:[],expandable:false,status:'warn'});
    if(lastSentAnswer && (questionId===undefined || lastSentAnswer.questionId===questionId) && !$('composer').value){
      $('composer').value=lastSentAnswer.text;
      updateSendEnabled();
    }
    lastSentAnswer=null;
  }

  /**
   * Classifies one stripped log line into a lookup "kind" plus how many
   * files/patterns/directories it covers, so closeLookupGroup can build one
   * readable summary ("Read 3 files, searched 2 patterns") instead of a bare
   * count — the same batched/single message shapes agentLoop.ts's read_file,
   * search_code, list_files and get_file_outline branches actually log.
   */
  function classifyLookup(line){
    var m;
    if((m=line.match(/^Read (\\d+) file\\(s\\):/))) return {kind:'read',count:+m[1]};
    if(/^Read file:/.test(line)) return {kind:'read',count:1};
    if((m=line.match(/^Searched code with pattern: (.+?) →/))){
      var count=(m[1].match(/"/g)||[]).length/2;
      return {kind:'search',count:count||1};
    }
    if(/^Scanned directory:/.test(line)) return {kind:'scan',count:1};
    if((m=line.match(/^Outlined (\\d+) file\\(s\\):/))) return {kind:'outline',count:+m[1]};
    if(/^Outlined declarations in:/.test(line)) return {kind:'outline',count:1};
    return null;
  }

  function closeLookupGroup(){
    if(lookupGroup){
      if(lookupGroup.detail.length){
        var c=lookupGroup.counts||{};
        var parts=[];
        if(c.read) parts.push('read '+c.read+' file'+(c.read===1?'':'s'));
        if(c.search) parts.push('searched '+c.search+' pattern'+(c.search===1?'':'s'));
        if(c.scan) parts.push('scanned '+c.scan+' director'+(c.scan===1?'y':'ies'));
        if(c.outline) parts.push('outlined '+c.outline+' file'+(c.outline===1?'':'s'));
        var joined=parts.join(', ');
        lookupGroup.summary=joined ? (joined.charAt(0).toUpperCase()+joined.slice(1)) :
          ('🔍 '+lookupGroup.detail.length+' lookup'+(lookupGroup.detail.length>1?'s':''));
        addRow(lookupGroup);
      }
      lookupGroup=null;
    }
  }

  function stripAnsi(s){ return s.replace(/\\x1b\\[[0-9;]*m/g,''); }

  function escapeHtml(s){
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Source names read as code even when whoever wrote the line didn't reach
  // for backticks. Extensions are listed explicitly, and the trailing
  // lookahead rejects a match followed by more path, so a model version like
  // "gemini-3.8-flash" or a host like "box.tail123.ts.net" is never mistaken
  // for a file.
  //
  // Doubled backslashes are mandatory throughout this page: it is all one
  // template literal, which eats the backslash on any escape it doesn't
  // recognize. Halving them here once emitted a regex whose asterisks were
  // unescaped, which the parser read as a block comment — every log row threw
  // and the feed rendered blank. test/deviceUi.test.ts guards against it.
  var FILE_RE=/\\b([\\w\\/.-]*\\.(?:kt|kts|java|ts|tsx|js|jsx|py|rs|go|rb|php|swift|c|cpp|h|cs|sh|sql|json|ya?ml|xml|gradle|toml|md|css|html?))(?![.\\w])/g;

  // A full source path (app/src/main/java/com/yimpim/mutantchickenracers/data/GameRepository.kt)
  // is mostly package boilerplate that repeats identically on every line — on
  // a phone-width screen it eats 3-4 lines to say what the last two segments
  // already say. The immediate folder plus filename is what actually varies.
  function shortenPath(p){
    var parts=p.split('/');
    return parts.length>2 ? parts.slice(-2).join('/') : p;
  }

  function inlineFormat(t){
    return t.replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>').replace(FILE_RE,'<code>$1</code>');
  }

  /**
   * Turns the markdown-lite convention (backtick \`code\` spans, **bold**)
   * mirrored from the desktop into real HTML — the browser-side twin of
   * richText.ts's toAnsi, kept separate since this runs in a browser, not
   * Node. Escapes HTML first, so any raw '<'/'>'/'&' in the text (a generic
   * type, a comparison in a bug report) can never be interpreted as markup
   * and the result is safe to feed straight into innerHTML.
   */
  function richTextToHtml(s){
    var esc=escapeHtml(s);
    // Walk the explicit backtick spans and format only the text BETWEEN them,
    // so auto-highlighting can never rewrite the inside of a span, or the
    // tags this very function just produced.
    var out='', last=0, re=/\`([^\`]+)\`/g, m;
    while((m=re.exec(esc))!==null){
      out+=inlineFormat(esc.slice(last,m.index))+'<code>'+m[1]+'</code>';
      last=m.index+m[0].length;
    }
    return out+inlineFormat(esc.slice(last));
  }

  /**
   * Classifies one mirrored desktop console line into the row model above.
   * Three collapsing rules, aimed at the actual noise sources rather than
   * hiding anything: routine model-call chatter (every retry, every "still
   * waiting") becomes a transient status line, never permanent scrollback;
   * consecutive read/scan/search/outline calls (all signal-free on their
   * own) batch into one "N lookups" row; a patch/write's start line is
   * upgraded IN PLACE once its result arrives, rather than adding a second
   * row — and if the result never arrives (a failed patch throws before
   * logging one), the start row just stays as "Editing X…", which is the
   * honest outcome, not a silently swallowed action. Everything else is
   * unrecognized and shown exactly as before: one row, untouched.
   */
  function ingestRemote(raw,level){
    var msg=stripAnsi(raw);

    // A run of "=", "-" or "#" is a terminal separator (stage banners use
    // "=", phase banners use "#"). On a phone it wraps onto a second line and
    // reads as garbage; this page has a real rule, so use it. Collapsed when
    // one already sits at the bottom, since the desktop prints these in pairs
    // around a heading.
    if(/^\\s*[=#-]{6,}\\s*$/.test(msg)){
      closeLookupGroup();
      if(rows.length && rows[rows.length-1].rule) return;
      addRow({rule:true});
      return;
    }

    var calling=msg.match(/^\\[API\\] Calling (.+?) —/);
    if(calling){ busyText='⚡ '+calling[1]+'…'; renderLog(); return; }
    if(/^\\[API\\].*(✔|❌)/.test(msg) || /^\\[API\\] Still waiting/.test(msg)){ busyText=''; renderLog(); return; }

    var stripped=msg.replace(/^\\[[A-Za-z0-9_-]+\\]\\s*/,'');
    var lookupKind=classifyLookup(stripped);
    if(lookupKind){
      if(!lookupGroup) lookupGroup={summary:'',detail:[],expandable:true,expanded:false,status:'done',counts:{read:0,search:0,scan:0,outline:0}};
      lookupGroup.detail.push(stripped);
      lookupGroup.counts[lookupKind.kind]+=lookupKind.count;
      return;
    }
    closeLookupGroup();

    var done=msg.match(/(?:patched|rewrote|created) (.+?)\\s+\\+(\\d+) -(\\d+)/);
    if(done){
      var verb=/patched/.test(msg)?'Patched':/rewrote/.test(msg)?'Rewrote':'Created';
      var short=shortenPath(done[1]);
      var text=verb+' '+short+'  +'+done[2]+' -'+done[3];
      var html=verb+' <code>'+escapeHtml(short)+'</code>  '+
                '<span class="diff-add">+'+done[2]+'</span> <span class="diff-del">-'+done[3]+'</span>';
      var pending=pendingEdits[done[1]];
      var editedRow;
      if(pending){ pending.summary=text; pending.html=html; pending.status='done'; delete pendingEdits[done[1]]; editedRow=pending; renderLog(); }
      else editedRow=addRow({summary:text,html:html,detail:[],expandable:false,status:'done'});
      // Kept (not deleted) so the file.changed event that follows moments
      // later — same write, pushed as a second, structured event — can still
      // find this row and attach the changeId a fetch_diff tap needs.
      recentEdits[done[1]]=editedRow;
      return;
    }
    var starting=msg.match(/(?:Patching file|Writing file): (.+?)\\.{0,3}$/);
    if(starting){
      pendingEdits[starting[1]]=addRow({summary:'✏️ Editing '+shortenPath(starting[1])+'…',detail:[],expandable:false,status:'pending'});
      return;
    }

    // The QA verdict banner (evidence.ts's renderSummary) is one console.log
    // call with the whole multi-line report embedded — without this it fell
    // through to the generic one-row fallback below as a single wall-of-text
    // blob. Split into a heading (bold, colored by pass/fail) plus the full
    // report as expandable detail, reusing the same collapse mechanism
    // lookups already use, auto-expanded only when it's the outcome that
    // actually needs a look.
    var verdict=msg.match(/\\*\\*Verdict: (PASS|FAIL)\\*\\*\\s*\\(confidence: ([a-z-]+)\\)/);
    if(verdict){
      closeLookupGroup();
      var vLines=msg.split('\\n').map(function(l){return l.trim();}).filter(function(l){
        return l.length>0 && !/^\\[QA\\]\\s*=+$/.test(l) && !/^\\*\\*Verdict:/.test(l);
      });
      var vHead=(verdict[1]==='PASS'?'✅':'🛑')+' **QA '+verdict[1]+'** — confidence: '+verdict[2];
      addRow({summary:vHead,detail:vLines,expandable:true,expanded:verdict[1]==='FAIL',status:verdict[1]==='FAIL'?'error':'done'});
      return;
    }

    // Same idea for the static reviewer's own report (staticQa.ts's
    // renderReview) — summary line plus per-requirement bullets, also
    // mirrored as one multi-line console.log call.
    if(/^\\[QA\\] Static review:/.test(msg)){
      closeLookupGroup();
      var srLines=msg.replace(/^\\[QA\\] Static review:\\n?/,'').split('\\n').filter(function(l){return l.trim().length>0;});
      addRow({summary:'🔎 Static review',detail:srLines,expandable:true,expanded:false,status:'done'});
      return;
    }

    // Per-agent token usage (events.ts's renderUsage) — one console.log call
    // with a header line plus a fixed-width padded row per agent. The padding
    // aligns columns in a monospace terminal; on this page's proportional
    // serif font it means nothing, and with the newlines it relied on for
    // separation collapsing (below), it read as one run-on sentence of
    // "EDITOR 47 calls 2.6M tokens DISCOVERY 14 calls…". A real table reads
    // as a table regardless of font.
    // Without the m flag, ^ only anchors to position 0 — but the source
    // string (events.ts's renderUsage) leads with a blank line before the
    // header, so an unanchored-by-line match missed it entirely and this fell
    // through to the generic multi-line fallback below.
    var usageHeader=msg.match(/^(.*Token usage[^:\\n]*:)/m);
    if(usageHeader){
      // The trailing $ figure (events.ts's renderUsage, formatCost) is only
      // ever present when OpenRouter actually reported real billed cost for
      // that bucket — absent for a provider/route that didn't, not printed
      // as a misleading $0.00.
      var rowRe=/^\\s*(\\S+)\\s+(\\d+)\\s+calls\\s+(\\S+)\\s+tokens(?:\\s+(\\\$[\\d.]+))?\\s*$/gm;
      var usageRows=[], um, anyCost=false;
      while((um=rowRe.exec(msg))!==null){
        usageRows.push(um);
        if(um[4]) anyCost=true;
      }
      if(usageRows.length){
        closeLookupGroup();
        var trs=usageRows.map(function(r){
          var isTotal=r[1].toUpperCase()==='TOTAL';
          var costCell=anyCost?'<td>'+(r[4]?escapeHtml(r[4]):'—')+'</td>':'';
          return '<tr'+(isTotal?' class="usage-total"':'')+'><td>'+escapeHtml(r[1])+'</td>'+
                 '<td>'+escapeHtml(r[2])+'</td><td>'+escapeHtml(r[3])+'</td>'+costCell+'</tr>';
        }).join('');
        var usageTable='<table class="usage-table"><thead><tr><th>Agent</th><th>Calls</th><th>Tokens</th>'+
                        (anyCost?'<th>Cost</th>':'')+'</tr></thead><tbody>'+trs+'</tbody></table>';
        addRow({summary:'📊 Token usage for this task',detail:[],bodyHtml:usageTable,expandable:true,expanded:true,status:'done'});
        return;
      }
    }

    var isProblem=level==='warn'||level==='error'||/✗|❌|FAILED|\\[DIAGNOSTIC\\]/.test(msg);

    // Any other multi-line message (e.g. an Editor/Repair's own conclude_task
    // explanation, one claim per line by convention) fell through here as a
    // single blob — the newlines it depended on for separation are invisible
    // once rendered as HTML, so a handful of distinct claims read as one
    // run-on paragraph. Same per-line treatment as the QA/static-review rows
    // above, just for whatever wasn't specifically recognized. Expanded by
    // default: unlike those, this line IS the content, not supplementary
    // detail, so collapsing it by default would hide the answer.
    var mlLines=msg.split('\\n').map(function(l){return l.trim();}).filter(function(l){return l.length>0;});
    if(mlLines.length>1){
      closeLookupGroup();
      var mlHead=mlLines.shift();
      addRow({summary:mlHead,detail:mlLines,expandable:true,expanded:true,status:level==='error'?'error':(isProblem?'warn':'done')});
      return;
    }

    addRow({summary:msg,detail:[],expandable:false,status:level==='error'?'error':(isProblem?'warn':'done')});
  }

  /**
   * Reassembles one screenshot from base64 chunks, keyed by the id the
   * desktop generated for it. Each chunk is a multiple of 3 raw bytes
   * (48KB), so its base64 encoding carries no padding except possibly on the
   * final chunk — plain string concatenation in sequence order reproduces
   * the exact base64 of the whole file, no decode/re-encode needed.
   */
  function ingestScreenshotChunk(ev){
    var buf=screenshotBuffers[ev.id];
    if(!buf){ buf=screenshotBuffers[ev.id]={total:ev.total,mime:ev.mime,label:ev.label,chunks:{}}; }
    buf.chunks[ev.seq]=ev.data;
    if(Object.keys(buf.chunks).length<buf.total) return;
    delete screenshotBuffers[ev.id];
    var parts=[];
    for(var i=0;i<buf.total;i++) parts.push(buf.chunks[i]||'');
    closeLookupGroup();
    addRow({summary:'📷 '+(buf.label||'screenshot'),detail:[],expandable:false,status:'done',
            image:'data:'+(buf.mime||'image/png')+';base64,'+parts.join('')});
  }

  function poll(){
    if(stopped) return;
    // The server's own long-poll window is 25s (LONG_POLL_MS in broker.ts) —
    // this must stay comfortably above that so a legitimately slow-but-working
    // long-poll doesn't get mistaken for a hang. Without SOME timeout here, a
    // fetch that never resolves would mean nothing ever schedules the next
    // poll() call at all — not just that one request stalling, the entire
    // reconnect loop permanently stopping.
    fetch('/v1/stream?sessionId='+encodeURIComponent(cfg.sessionId)+'&after='+after,
          {headers:{'authorization':'Bearer '+token},signal:AbortSignal.timeout(35000)})
      .then(function(r){
        if(r.status===401){
          // The cached session is genuinely dead (swept server-side after 12h
          // idle, or the desktop process restarted and forgot every session —
          // it's in-memory only there too) — retrying with the same token
          // forever would never recover, so stop and say so plainly instead
          // of sitting on OFFLINE with no explanation.
          clearSavedSession();
          stopped=true;
          fail('This session is no longer valid. Scan a fresh QR code from the desktop.');
          throw new Error('unauthorized');
        }
        if(!r.ok) throw new Error('HTTP '+r.status);
        return r.json();
      })
      .then(function(b){
        setOnline(true);
        var chain=Promise.resolve();
        (b.events||[]).forEach(function(env){
          if(env.seq>after) after=env.seq;
          if(seenEventSeqs[env.seq]) return;
          seenEventSeqs[env.seq]=1;
          seenEventSeqCount++;
          if(seenEventSeqCount>1000){ seenEventSeqs={}; seenEventSeqCount=0; }
          chain=chain.then(function(){ return openEnv(env).then(handleEvent)
            .catch(function(){ note('[undecryptable event dropped]','warn'); }); });
        });
        return chain;
      })
      .catch(function(e){ setOnline(false); })
      .then(function(){ if(!stopped) pollTimer=setTimeout(poll, 1200); });
  }

  // Mobile browsers throttle or fully suspend a backgrounded tab's timers to
  // save battery — switching tabs for a while can leave the 1.2s poll loop
  // not actually firing, so the page just sits on whatever it last knew
  // (often "offline") until it happens to wake up on its own, which can take
  // a long time. visibilitychange fires promptly even for a throttled tab,
  // so returning to this tab cancels whatever's pending and polls right away
  // instead of waiting on the throttled timer.
  document.addEventListener('visibilitychange', function(){
    if(!document.hidden && !stopped){
      if(pollTimer){ clearTimeout(pollTimer); pollTimer=null; }
      poll();
    }
  });

  function saveSession(){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify({sessionId:cfg.sessionId, key:cfg.key, token:token})); }catch(e){}
  }
  function clearSavedSession(){
    try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
  }

  if(restoredToken){
    // Reconnecting after a refresh, not a fresh pairing — the pairing code
    // was already burned the first time (single-use server-side), so
    // re-running /v1/pair here would just fail with "already paired". Go
    // straight to using the previously-established device token instead.
    token=restoredToken;
    importKey().then(function(k){
      key=k;
      setOnline(true);
      poll();
    }).catch(function(e){
      clearSavedSession();
      fail('Saved session could not be restored ('+e.message+'). Scan the QR code shown on your desktop.');
    });
  } else {
    importKey().then(function(k){
      key=k;
      return fetch('/v1/pair',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({sessionId:cfg.sessionId,pairing:cfg.pairing,label:navigator.platform||'phone'}),
        signal:AbortSignal.timeout(15000)});
    }).then(function(r){
      if(!r.ok) return r.json().then(function(j){ throw new Error(j.error||('HTTP '+r.status)); });
      return r.json();
    }).then(function(j){
      token=j.deviceToken;
      saveSession();
      setOnline(true);
      poll();
    }).catch(function(e){
      // A hung request (desktop unreachable, Tailscale not actually connected on
      // this device, etc.) used to leave the page silently stuck on "OFFLINE"
      // forever with no explanation — this is what turns that into an actual,
      // actionable message instead of an indefinite wait.
      var msg=e.name==='TimeoutError'||e.name==='AbortError'
        ? 'Could not reach the desktop within 15s. Check that Tailscale is connected on this ' +
          'phone (open the Tailscale app), that the desktop is still running, and that the QR ' +
          'code has not expired (2 minutes) — then re-run /remote-control for a fresh one.'
        : e.message;
      fail('Pairing failed: '+msg);
      setOnline(false);
    });
  }

  $('plus').onclick=function(){ $('afile').click(); };
  $('afile').onchange=function(e){
    var f=e.target.files[0]; e.target.value='';
    if(!f) return;
    if(f.size>MAX){ note('✗ '+f.name+' is too large (max 10 MB)','error'); return; }
    var name=f.name, mime=f.type||'application/octet-stream';
    // GIF is left alone — a canvas redraw only captures its first frame,
    // which would silently flatten an animated reference into a still.
    var isImage=mime.slice(0,6)==='image/' && mime!=='image/gif';
    // Read now, not when Send is pressed — see uploadFile's comment for why
    // waiting risks a stale File handle by then instead of a clean read now.
    var read=isImage ? downscaleImage(f) : f.arrayBuffer().then(function(buf){ return {bytes:new Uint8Array(buf), mime:mime}; });
    read.then(function(result){
      pendingFile={name:name,mime:result.mime,bytes:result.bytes};
      $('attachname').textContent=name;
      $('attachrow').classList.remove('hide');
    }).catch(function(err){
      note('✗ could not read '+name+': '+err.message,'error');
    });
  };
  $('attachx').onclick=function(){
    pendingFile=null;
    $('attachrow').classList.add('hide');
  };
  $('composer').oninput=function(){ updateSendEnabled(); updateSuggest(); };

  // A plain JS flag, checked and set synchronously, on top of the .disabled
  // guard below — .disabled is a DOM property, and this makes the "only one
  // send in flight" rule hold regardless of any rendering/paint timing, a
  // stray duplicate event, or anything else that might let a second call
  // through before the DOM has caught up.
  var sendInFlight=false;
  $('send').onclick=function(){
    if(!mode || $('send').disabled || sendInFlight) return;
    // Typed manually (not tapped from the suggestion list, which already
    // opens the wizard directly) — still opens it instead of sending "/model"
    // as literal text, which the desktop would just queue as an answer/
    // instruction, not a command.
    if(/^\\/model$/i.test($('composer').value.trim())){
      $('composer').value=''; updateSuggest(); updateSendEnabled();
      openModelModal();
      return;
    }
    sendInFlight=true;
    var text=$('composer').value.trim();
    var file=pendingFile;
    $('send').disabled=true; $('composer').disabled=true;

    if(text) lastSentAnswer={questionId:pendingQid,text:text};

    (file?uploadFile(file):Promise.resolve()).then(function(){
      if(mode==='answer') return send('answer',{questionId:pendingQid,answer:text});
      return send('message',{text:text});
    }).then(function(){
      $('composer').value='';
      updateSuggest();
      pendingFile=null; $('attachrow').classList.add('hide');
      note('→ sent');
    }).catch(function(e){
      note('✗ send failed: '+e.message,'error');
    }).then(function(){
      sendInFlight=false;
      $('composer').disabled=!isOnline;
      updateSendEnabled();
    });
  };

  $('statusrow').onclick=function(){ $('phases').classList.toggle('hide'); };

  $('lightbox').onclick=closeLightbox;
  $('diffClose').onclick=closeDiffModal;
  $('diffModal').onclick=function(e){ if(e.target.id==='diffModal') closeDiffModal(); };
  $('modelClose').onclick=closeModelModal;
  $('modelModal').onclick=function(e){ if(e.target.id==='modelModal') closeModelModal(); };

  $('abort').onclick=function(){
    if(!confirm('Stop the current run?')) return;
    send('abort',{reason:'phone'}).then(function(){ note('→ abort sent'); });
  };
})();
</script>
</body>
</html>`;
