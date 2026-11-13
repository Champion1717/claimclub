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
      setTimeout(function(){c.setState({pi:0,step:idx(c,kind==='member'?'perks':'bank')})},1300);
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
    if(c.stepName()==='dash'){setTimeout(function(){location.href='app.html'},50)}
    return v;
  };
})();
