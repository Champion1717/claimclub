// Live-site hook: sends the filing fee / membership to Stripe Checkout and resumes the flow on return.
(function(){
  // Set STRIPE to true to send the filing fee and memberships to Stripe Checkout.
  // While false, the built-in test checkout page is used and no real charge is made.
  var STRIPE=false;
  var KEY='cc_flow', q=new URLSearchParams(location.search), started=false;
  function idx(c,n){return c.steps().indexOf(n)}
  function go(c,kind){
    try{sessionStorage.setItem(KEY,JSON.stringify(c.state))}catch(e){}
    c.setState({buying:kind,payState:'busy',step:idx(c,'checkout')});
    fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:kind,plan:c.state.plan,email:c.state.email,lang:c.state.lang,ids:c.matched().map(function(m){return m.id}),path:location.pathname})})
      .then(function(r){return r.json()}).then(function(j){if(j.url)location.href=j.url;else throw new Error(j.error||'no url')})
      .catch(function(e){console.error(e);alert('Checkout is unavailable right now. Please try again.');c.setState({payState:'',step:idx(c,'pay')})});
  }
  function resume(c){
    var saved=null;try{saved=JSON.parse(sessionStorage.getItem(KEY)||'null')}catch(e){}
    if(saved){Object.assign(c.state,saved)}
    if(q.get('canceled')){c.state.payState='';c.state.step=idx(c,c.state.buying==='member'?'plans':'pay');history.replaceState(null,'',location.pathname);return}
    var sid=q.get('sid'),kind=q.get('paid')==='member'?'member':'fee';
    c.state.buying=kind;c.state.payState='busy';c.state.step=idx(c,'checkout');
    history.replaceState(null,'',location.pathname);
    fetch('/api/session?id='+encodeURIComponent(sid)).then(function(r){return r.json()}).then(function(j){
      if(!j.paid)throw new Error('not paid');
      c.setState({payState:'done',paid:kind});c.saveForApp();
      try{sessionStorage.removeItem(KEY)}catch(e){}
      if(c.finishPay)c.finishPay(kind);else setTimeout(function(){c.setState({pi:0,step:idx(c,kind==='member'?'perks':'bank')})},1300);
    }).catch(function(){c.setState({payState:'',step:idx(c,'pay')})});
  }
  window.ccLive=function(c,v){
    if(STRIPE){
      if(!started){started=true;if(q.get('sid')||q.get('canceled'))resume(c)}
      v.unlock=function(){go(c,'fee')};
      v.subscribe=function(){go(c,'member')};
      v.payNow=function(){go(c,c.state.buying||'fee')};
      v.payCard=v.payNow;
    }
    // Never paint the flow's placeholder dashboard step: cover the page and open the real dashboard.
    if(!c.__ccExit){c.__ccExit=true;c.afterBank=function(){c.saveForApp();enterApp()}}
    if(c.stepName()==='dash'){enterApp()}
    if(c.stepName()==='perks'||c.stepName()==='bank'){prefetchApp()}
    return v;
  };
  var leaving=false,prefetched=false;
  function prefetchApp(){if(prefetched)return;prefetched=true;var l=document.createElement('link');l.rel='prefetch';l.href='app.html';document.head.appendChild(l)}
  function cover(fadeIn){
    var d=document.createElement('div');d.id='ccCover';
    d.setAttribute('aria-hidden','true');
    d.style.cssText='position:fixed;inset:0;z-index:99999;background:#F3F6F4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;font-family:Manrope,sans-serif;transition:opacity .38s ease;opacity:'+(fadeIn?'0':'1');
    d.innerHTML='<div style="width:44px;height:44px;border-radius:50%;border:3px solid #DDE5E0;border-top-color:#12805C;animation:ccSpin .8s linear infinite"></div><div style="font-size:14px;font-weight:700;color:#5B6862">Opening your dashboard</div><style>@keyframes ccSpin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){#ccCover div{animation:none!important}}</style>';
    document.body.appendChild(d);return d;
  }
  function enterApp(){
    if(leaving)return;leaving=true;
    try{sessionStorage.setItem('cc_enter','1')}catch(e){}
    var d=cover(true);requestAnimationFrame(function(){requestAnimationFrame(function(){d.style.opacity='1'})});
    setTimeout(function(){location.href='app.html'},420);
  }
  // Arriving on the dashboard from the flow: start covered, then fade the cover away once the page has painted.
  if(/\/app\.html$/.test(location.pathname)){
    var came=false;try{came=sessionStorage.getItem('cc_enter')==='1';sessionStorage.removeItem('cc_enter')}catch(e){}
    if(came){var go2=function(){var d=cover(false);setTimeout(function(){d.style.opacity='0';setTimeout(function(){d.remove()},420)},260)};if(document.body)go2();else document.addEventListener('DOMContentLoaded',go2)}
  }
})();
