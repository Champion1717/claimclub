// Live-site hook: sends the filing fee / membership to Stripe Checkout and resumes the flow on return.
(function(){
  // Set STRIPE to true to send the filing fee and memberships to Stripe Checkout.
  // While false, the built-in test checkout page is used and no real charge is made.
  var STRIPE=true;
  var KEY='cc_flow', q=new URLSearchParams(location.search), started=false;
  function idx(c,n){return c.steps().indexOf(n)}
  // Stripe's hosted page: the fallback when the in-page sheet cannot run.
  function go(c,kind){
    try{sessionStorage.setItem(KEY,JSON.stringify(c.state))}catch(e){}
    c.setState({buying:kind,payState:'busy',step:idx(c,'checkout')});
    post(c,kind,{})
      .then(function(j){if(j.url)location.href=j.url;else throw new Error(j.error||'no url')})
      .catch(function(e){console.error(e);alert('Checkout is unavailable right now. Please try again.');c.setState({payState:'',step:idx(c,kind==='member'?'plans':'pay')})});
  }
  function post(c,kind,extra){
    var b={kind:kind,plan:c.state.plan,email:c.state.email,lang:c.state.lang,ids:c.matched().map(function(m){return m.id}),path:location.pathname};
    for(var k in extra)b[k]=extra[k];
    return fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json()});
  }
  // Confirms a finished payment with the server, then carries on with the flow (perks for members, bank or dashboard for the fee).
  function verify(c,kind,sid,inRender){
    var busy={buying:kind,payState:'busy',step:idx(c,'checkout')};
    if(inRender)Object.assign(c.state,busy);else c.setState(busy);
    fetch('/api/session?id='+encodeURIComponent(sid)).then(function(r){return r.json()}).then(function(j){
      if(!j.paid)throw new Error('not paid');
      c.setState({payState:'done',paid:kind});c.saveForApp();
      try{sessionStorage.removeItem(KEY)}catch(e){}
      if(c.finishPay)c.finishPay(kind);else setTimeout(function(){c.setState({pi:0,step:idx(c,kind==='member'?'perks':'bank')})},1300);
    }).catch(function(){c.setState({payState:'',step:idx(c,kind==='member'?'plans':'pay')})});
  }

  /* ---------- In-page payment sheet (Nov 15 2026, canvas boards PayF1/PayF2) ----------
     Phones: a sheet slides up over the receipt page, with a short receipt strip on top, then Stripe's
     Apple Pay / Google Pay buttons and card form. Computers: the right column turns into Checkout while
     the receipt stays in the side panel. Anything that stops it (no publishable key, Stripe.js not
     loading, a session error) falls back to Stripe's hosted page. */
  var SJS='https://js.stripe.com/endive/stripe.js', sjsP=null, openNow=null;
  function loadStripe(){
    if(window.Stripe)return Promise.resolve(window.Stripe);
    if(sjsP)return sjsP;
    sjsP=new Promise(function(ok,no){var t=document.createElement('script');t.src=SJS;t.async=true;t.onload=function(){window.Stripe?ok(window.Stripe):no(new Error('Stripe.js missing'))};t.onerror=function(){sjsP=null;no(new Error('Stripe.js did not load'))};document.head.appendChild(t)});
    return sjsP;
  }
  function esc(t){return String(t==null?'':t).replace(/[&<>"]/g,function(ch){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]})}
  var IC={lock:'<path d="M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M7 11V7a5 5 0 0 1 10 0v4"/>',x:'<path d="M18 6 6 18 M6 6l12 12"/>',check:'<path d="M20 6 9 17l-5-5"/>',back:'<path d="m15 18-6-6 6-6"/>',shield:'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',mail:'<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z m18 2-10 7L2 6"/>'};
  function ic(k,sz,c,sw){return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="'+c+'" stroke-width="'+(sw||2.2)+'" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none">'+IC[k]+'</svg>'}
  function css(){
    if(document.getElementById('ccPayCss'))return;
    var st=document.createElement('style');st.id='ccPayCss';
    st.textContent=
'.ccp{position:fixed;z-index:9000;font-family:Manrope,system-ui,sans-serif;color:#0A0F0D}'+
'.ccp *{box-sizing:border-box}'+
'.ccp-m{inset:0}.ccp-bd{position:absolute;inset:0;background:rgba(10,15,13,.45);opacity:0;transition:opacity .2s ease}'+
'.ccp-m .ccp-panel{position:absolute;left:0;right:0;bottom:0;max-height:94svh;overflow-y:auto;-webkit-overflow-scrolling:touch;background:#FFFFFF;border-radius:28px 28px 0 0;padding:10px 18px calc(24px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:14px;box-shadow:0 -20px 40px rgba(10,15,13,.18);transform:translateY(100%);transition:transform .28s cubic-bezier(.2,.8,.2,1)}'+
'.ccp-open .ccp-bd{opacity:1}.ccp-m.ccp-open .ccp-panel{transform:none}'+
'.ccp-handle{width:40px;height:5px;border-radius:99px;background:#D5DDD8;align-self:center;flex:none}'+
'.ccp-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.ccp-head b{font-size:20px;font-weight:800}.ccp-sub{display:block;font-size:13px;color:#5B6862;font-weight:600;margin-top:2px}'+
'.ccp-x{width:34px;height:34px;flex:none;border:0;border-radius:99px;background:#EEF2F0;display:flex;align-items:center;justify-content:center;cursor:pointer}'+
'.ccp-strip{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-radius:16px;background:#E9F6EF}'+
'.ccp-strip .l{display:flex;flex-direction:column;gap:1px}.ccp-strip .l span{font-size:12px;font-weight:700;color:#17603F}.ccp-strip .l b{font-size:22px;letter-spacing:-.6px;color:#12805C;font-weight:800}'+
'.ccp-strip .r{display:flex;flex-direction:column;align-items:flex-end;gap:3px;text-align:right}.ccp-strip .r span:first-child{display:flex;align-items:center;gap:5px;font-size:12.5px;font-weight:800;color:#17603F}.ccp-strip .r span:last-child{font-size:12px;font-weight:700;color:#5B6862}'+
'.ccp-body{position:relative;display:flex;flex-direction:column;gap:14px}'+
'.ccp-load{position:absolute;left:0;right:0;top:0;height:200px;display:flex;align-items:center;justify-content:center;gap:10px;color:#5B6862;font-size:14px;font-weight:700;z-index:1}'+
'.ccp-spin{width:18px;height:18px;border-radius:50%;border:2.5px solid #DDE5E0;border-top-color:#12805C;animation:ccpSpin .8s linear infinite}@keyframes ccpSpin{to{transform:rotate(360deg)}}'+
'.ccp-body.loading .ccp-x2,.ccp-body.loading .ccp-or,.ccp-body.loading .ccp-card,.ccp-body.loading .ccp-pay,.ccp-body.loading .ccp-mail{opacity:0;pointer-events:none}'+
'.ccp-x2,.ccp-or,.ccp-card,.ccp-pay,.ccp-mail{transition:opacity .25s ease}'+
'.ccp-x2:empty{display:none}.ccp-card{min-height:60px}'+
'.ccp-or{display:flex;align-items:center;gap:12px;color:#8A968F;font-size:12.5px;font-weight:700}.ccp-or::before,.ccp-or::after{content:"";flex:1;height:1px;background:#DDE5E0}.ccp-or[hidden],.ccp-err[hidden]{display:none}'+
'.ccp-kick{font-size:12px;font-weight:800;letter-spacing:1px;color:#8A968F}'+
'.ccp-pay{height:54px;width:100%;border:0;border-radius:99px;background:#3DDC97;color:#0F3B2E;font:800 16px Manrope,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;box-shadow:0 10px 24px rgba(61,220,151,.35)}.ccp-pay:disabled{opacity:.6;cursor:default}'+
'.ccp-err{font-size:13.5px;font-weight:700;color:#C8323B;line-height:1.45}'+
'.ccp-sec{margin:0;display:flex;align-items:center;justify-content:center;gap:6px;font-size:11.5px;color:#8A968F;font-weight:700;text-align:center}'+
'.ccp-mail{display:flex;align-items:center;gap:8px;font-size:13px;color:#5B6862;font-weight:600}.ccp-mail b{color:#0A0F0D}'+
'.ccp-d{background:#FBFAFE;overflow-y:auto;opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .24s cubic-bezier(.2,.7,.2,1)}.ccp-d.ccp-open{opacity:1;transform:none}'+
'.ccp-d .ccp-panel{width:min(520px,100%);margin:0 auto;padding:26px 24px 30px;display:flex;flex-direction:column;gap:16px}'+
'.ccp-backl{align-self:flex-start;border:0;background:transparent;display:flex;align-items:center;gap:6px;font:800 14px Manrope,system-ui,sans-serif;color:#5B6862;cursor:pointer;padding:4px 0}'+
'.ccp-h1{margin:0;font-size:30px;line-height:1.12;font-weight:800;letter-spacing:-.9px}.ccp-d .ccp-sub{margin-top:-8px;font-size:15px}'+
'@media (prefers-reduced-motion:reduce){.ccp-bd,.ccp-panel,.ccp-d{transition:none!important}.ccp-spin{animation:none}}';
    document.head.appendChild(st);
  }
  function shell(c,kind,info){
    css();
    var es=info.es, mem=kind==='member', price=mem?info.mem:info.fee, sub=mem?info.memSub:info.feeSub;
    var main=document.querySelector('.deskmain'), desk=!!main;
    var T={pay:(es?'Pagar ':'Pay ')+price,or:es?'o paga con tarjeta':'or pay with card',load:es?'Cargando pago seguro':'Loading secure payment',
      sec:es?'Pagos cifrados y procesados por Stripe. Nunca vemos el número de tu tarjeta.':'Payments are encrypted and processed by Stripe. We never see your card number.',
      earn:es?'Ganancias esperadas':'Expected earnings',keep:es?'Te quedas con el 100%':'You keep 100%',today:es?' hoy':' today',back:mem?(es?'Volver a los planes':'Back to plans'):(es?'Volver':'Back'),
      mail:es?'Recibo a ':'Receipt to ',kick:es?'PAGO EXPRÉS':'EXPRESS CHECKOUT',close:es?'Cerrar':'Close'};
    var root=document.createElement('div');
    root.className='ccp '+(desk?'ccp-d':'ccp-m');
    root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label',T.pay);
    var strip=info.total?'<div class="ccp-strip"><span class="l"><span>'+esc(T.earn)+'</span><b>'+(es?'Hasta ':'Up to ')+esc(info.total)+'</b></span><span class="r"><span>'+ic('check',14,'#12805C',2.8)+esc(T.keep)+'</span><span>'+esc(info.count)+' · '+esc(price)+esc(T.today)+'</span></span></div>':'';
    var body='<div class="ccp-body loading"><div class="ccp-load" aria-live="polite"><span class="ccp-spin"></span>'+esc(T.load)+'</div>'+(desk?'<span class="ccp-kick">'+esc(T.kick)+'</span>':'')+'<div class="ccp-x2"></div><div class="ccp-or" hidden><span>'+esc(T.or)+'</span></div><div class="ccp-card"></div>'+
      (desk&&c.state.email?'<div class="ccp-mail">'+ic('mail',14,'#5B6862')+esc(T.mail)+'<b>'+esc(c.state.email)+'</b></div>':'')+
      '<div class="ccp-err" role="alert" hidden></div><button type="button" class="ccp-pay">'+ic('lock',16,'#0F3B2E',2.4)+'<span>'+esc(T.pay)+'</span></button><p class="ccp-sec">'+ic('shield',13,'#8A968F')+esc(T.sec)+'</p></div>';
    root.innerHTML=desk
      ?'<div class="ccp-panel"><button type="button" class="ccp-backl">'+ic('back',16,'#5B6862',2.4)+esc(T.back)+'</button><h2 class="ccp-h1">'+esc(T.pay)+'</h2><span class="ccp-sub">'+esc(sub)+'</span>'+body+'</div>'
      :'<div class="ccp-bd"></div><div class="ccp-panel"><span class="ccp-handle"></span><div class="ccp-head"><span><b>'+esc(T.pay)+'</b><span class="ccp-sub">'+esc(sub)+'</span></span><button type="button" class="ccp-x" aria-label="'+esc(T.close)+'">'+ic('x',16,'#0A0F0D')+'</button></div>'+strip+body+'</div>';
    function place(){if(!desk)return;var r=main.parentElement.getBoundingClientRect();root.style.left=r.left+'px';root.style.top=r.top+'px';root.style.width=r.width+'px';root.style.height=r.height+'px'}
    place();document.body.appendChild(root);
    var prevOv=document.body.style.overflow;if(!desk)document.body.style.overflow='hidden';
    requestAnimationFrame(function(){requestAnimationFrame(function(){root.classList.add('ccp-open')})});
    var closers=[],gone=false,closed=false;
    function remove(){if(gone)return;gone=true;try{c.setState({payOpen:false})}catch(e){}window.removeEventListener('resize',place);document.removeEventListener('keydown',key);root.classList.remove('ccp-open');if(openNow===api)openNow=null;setTimeout(function(){root.remove();document.body.style.overflow=prevOv},240)}
    function close(){closed=true;closers.forEach(function(f){try{f()}catch(e){}});remove()}
    function key(e){if(e.key==='Escape')close()}
    window.addEventListener('resize',place);document.addEventListener('keydown',key);
    [].forEach.call(root.querySelectorAll('.ccp-x,.ccp-bd,.ccp-backl'),function(b){b.addEventListener('click',close)});
    var api={root:root,T:T,q:function(s){return root.querySelector(s)},remove:remove,close:close,isClosed:function(){return closed},onClose:function(f){if(closed)f();else closers.push(f)}};
    var first=root.querySelector('.ccp-x,.ccp-backl');if(first)setTimeout(function(){try{first.focus({preventScroll:true})}catch(e){}},60);
    return api;
  }
  var APPEAR={theme:'stripe',variables:{colorPrimary:'#12805C',colorBackground:'#FFFFFF',colorText:'#0A0F0D',colorTextSecondary:'#5B6862',colorDanger:'#C8323B',fontFamily:'Manrope, system-ui, sans-serif',fontSizeBase:'16px',borderRadius:'12px',spacingUnit:'4px'},
    rules:{'.Input':{border:'1.5px solid #DDE5E0',boxShadow:'none',padding:'13px 14px'},'.Input:focus':{border:'1.5px solid #12805C',boxShadow:'0 0 0 1px #12805C'},'.Label':{color:'#43504A',fontSize:'13px',fontWeight:'700'}}};
  function sheet(c,kind,info){
    if(openNow)return;
    try{sessionStorage.setItem(KEY,JSON.stringify(c.state))}catch(e){}
    c.setState({buying:kind,payOpen:true});
    var sh=openNow=shell(c,kind,info);
    var fallback=function(e){
      if(sh.isClosed())return;
      console.error('[pay sheet]',e);sh.remove();go(c,kind);
    };
    var sjs=loadStripe().catch(function(e){return null});
    post(c,kind,{ui:'elements'}).then(function(j){
      if(sh.isClosed())return;
      if(!j.clientSecret||!j.publishableKey){
        sh.remove();
        if(j.url){try{sessionStorage.setItem(KEY,JSON.stringify(c.state))}catch(e){}c.setState({payState:'busy',step:idx(c,'checkout')});location.href=j.url;return}
        throw new Error(j.error||'no session');
      }
      return sjs.then(function(S){if(!S)throw new Error('Stripe.js did not load');return run(c,kind,sh,S(j.publishableKey),j.clientSecret)});
    }).catch(fallback);
  }
  function run(c,kind,sh,stripe,secret){
    var T=sh.T,body=sh.q('.ccp-body'),or=sh.q('.ccp-or'),btn=sh.q('.ccp-pay'),err=sh.q('.ccp-err'),label=btn.querySelector('span').textContent;
    var checkout=stripe.initCheckoutElementsSdk({clientSecret:secret,elementsOptions:{appearance:APPEAR,fonts:[{cssSrc:'https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&display=swap'}]}});
    var express=checkout.createExpressCheckoutElement({buttonHeight:54,buttonTheme:{applePay:'black',googlePay:'black'},buttonType:{applePay:'plain',googlePay:'plain'},layout:{maxColumns:1,overflow:'never'},paymentMethodOrder:['apple_pay','google_pay','link'],paymentMethods:{applePay:'always',googlePay:'always',link:'auto',paypal:'never',amazonPay:'never',klarna:'never'}});
    var card=checkout.createPaymentElement({layout:{type:'accordion',defaultCollapsed:false,radios:'never',spacedAccordionItems:false,visibleAccordionItemsCount:1},paymentMethodOrder:['card'],wallets:{applePay:'never',googlePay:'never',link:'never'}});
    var es=c.state.lang==='es';
    function showErr(m){err.textContent=m||'';err.hidden=!m}
    var shown=false;function reveal(){if(shown)return;shown=true;var l=sh.q('.ccp-load');if(l)l.remove();body.classList.remove('loading')}
    express.on('ready',function(ev){var m=ev&&ev.availablePaymentMethods;or.hidden=!(m&&Object.keys(m).some(function(k){return m[k]}))});
    express.on('loaderror',function(){or.hidden=true});
    card.on('ready',reveal);
    var actionsP=checkout.loadActions();
    function paid(res){var sid=(res.session&&res.session.id)||secret.split('_secret_')[0];sh.remove();verify(c,kind,sid)}
    express.on('confirm',function(event){
      showErr(null);
      actionsP.then(function(r){
        if(r.type!=='success'){if(event.paymentFailed)event.paymentFailed({reason:'fail'});showErr(es?'No se pudo iniciar el pago. Usa la tarjeta de abajo.':'Payment could not start. Try the card form below.');return}
        return r.actions.confirm({expressCheckoutConfirmEvent:event,redirect:'if_required'}).then(function(res){
          if(res.type==='success')paid(res);else showErr((res.error&&res.error.message)||(es?'El pago no se completó. Inténtalo de nuevo o usa una tarjeta.':'That payment did not go through. Try again or use a card.'));
        });
      });
    });
    btn.addEventListener('click',function(){
      if(btn.disabled)return;showErr(null);btn.disabled=true;btn.querySelector('span').textContent=es?'Procesando…':'Processing…';
      var reset=function(m){btn.disabled=false;btn.querySelector('span').textContent=label;showErr(m)};
      actionsP.then(function(r){
        if(r.type!=='success'){reset(es?'No se pudo iniciar el pago. Cierra esto e inténtalo de nuevo.':'Payment could not start. Close this and try again.');return}
        return r.actions.confirm({redirect:'if_required'}).then(function(res){
          if(res.type==='success')paid(res);else reset((res.error&&res.error.message)||(es?'La tarjeta no pasó. Revisa los datos o usa otra.':'That card did not go through. Check the details or try another card.'));
        });
      }).catch(function(e){reset(es?'Algo salió mal. Inténtalo de nuevo.':'Something went wrong. Please try again.')});
    });
    express.mount(sh.q('.ccp-x2'));card.mount(sh.q('.ccp-card'));
    var stuck=setTimeout(function(){if(!shown){var l=sh.q('.ccp-load');if(l)l.textContent=es?'Sigue cargando. Puedes cerrar esto e intentarlo de nuevo.':'Still loading. You can close this and try again.'}},12000);
    sh.onClose(function(){clearTimeout(stuck);try{express.destroy();card.destroy()}catch(e){}});
  }
  function resume(c){
    var saved=null;try{saved=JSON.parse(sessionStorage.getItem(KEY)||'null')}catch(e){}
    if(saved){Object.assign(c.state,saved)}
    if(q.get('canceled')){c.state.payState='';c.state.step=idx(c,c.state.buying==='member'?'plans':'pay');history.replaceState(null,'',location.pathname);return}
    var sid=q.get('sid'),kind=q.get('paid')==='member'?'member':'fee';
    history.replaceState(null,'',location.pathname);
    verify(c,kind,sid,true);
  }
  /* ---------- Email code in the claim flow (Nov 15) ----------
     The flow's "Confirm your email" step calls window.ccAuth. It signs the person in with Supabase's email
     code, using the same saved sign-in the dashboard reads, so the dashboard opens without another login.
     Right after, it links their Stripe purchase to the account (api/membership link) so Plaid can open. */
  var SBJS='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js', sbP=null;
  function sb(){
    if(sbP)return sbP;
    sbP=fetch('/api/config').then(function(r){return r.json()}).then(function(cfg){
      if(!cfg.supabaseUrl||!cfg.supabaseAnonKey)throw new Error('no supabase');
      var load=window.supabase?Promise.resolve():new Promise(function(ok,no){var t=document.createElement('script');t.src=SBJS;t.onload=ok;t.onerror=function(){no(new Error('Sign-in did not load'))};document.head.appendChild(t)});
      return load.then(function(){return window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true}})});
    });
    sbP.catch(function(){sbP=null});
    return sbP;
  }
  function token(){return sb().then(function(c){return c.auth.getSession()}).then(function(r){var s=r&&r.data&&r.data.session;if(!s)throw new Error('Not signed in');return s.access_token})}
  window.ccAuth={
    send:function(email){
      return sb().then(function(c){return c.auth.signInWithOtp({email:email,options:{shouldCreateUser:true}})})
        .then(function(r){return {error:r.error?r.error.message:''}}).catch(function(e){return {error:e.message||'failed'}});
    },
    verify:function(email,code){
      return sb().then(function(c){return c.auth.verifyOtp({email:email,token:code,type:'email'})}).then(function(r){
        if(r.error||!r.data||!r.data.session)return {ok:false};
        // attach the purchase they just made to the new account (membership row), quietly
        return fetch('/api/membership',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+r.data.session.access_token},body:JSON.stringify({action:'link'})}).catch(function(){}).then(function(){return {ok:true}});
      });
    }
  };
  /* Plaid in the claim flow: "Connect bank account" opens Plaid's window right here. If it cannot (not signed
     in, purchase not linked yet, Plaid down) it falls back to opening Plaid in the dashboard like before. */
  function plaidJs(){return window.Plaid?Promise.resolve():new Promise(function(ok,no){var t=document.createElement('script');t.src='https://cdn.plaid.com/link/v2/stable/link-initialize.js';t.onload=ok;t.onerror=function(){no(new Error('Plaid did not load'))};document.head.appendChild(t)})}
  function papi(tok,action,extra){var b={action:action};for(var k in extra)b[k]=extra[k];return fetch('/api/plaid',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok},body:JSON.stringify(b)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'plaid');return j})})}
  window.ccPlaid=function(c){
    var later=function(){try{localStorage.setItem('claimclub_connect','1')}catch(e){}c.afterBank()};
    c.setState({bankBusy:true});
    token().then(function(tok){
      return Promise.all([papi(tok,'link_token',{}),plaidJs()]).then(function(r){
        var h=window.Plaid.create({token:r[0].link_token,
          onSuccess:function(pt,meta){var inst=(meta&&meta.institution)||{};c.setState({bankDone:true});
            papi(tok,'exchange',{public_token:pt,institution:{name:inst.name,institution_id:inst.institution_id}}).catch(function(){}).then(function(){c.state.bankDone=true;c.afterBank()})},
          onExit:function(){c.setState({bankBusy:false})}});
        h.open();
      });
    }).catch(function(e){console.warn('[plaid in flow]',e&&e.message);later()});
  };
  window.ccLive=function(c,v){
    if(STRIPE){
      if(!started){started=true;if(q.get('sid')||q.get('canceled'))resume(c)}
      var info=v.sheetInfo||{};
      v.payFee=function(){sheet(c,'fee',info)};
      v.subscribe=function(){sheet(c,'member',info)};
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
  function prefetchApp(){if(prefetched)return;prefetched=true;var l=document.createElement('link');l.rel='prefetch';l.href='/dashboard';document.head.appendChild(l)}
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
    setTimeout(function(){location.href='/dashboard/claims'},420);
  }
  // Arriving on the dashboard from the flow: start covered, then fade the cover away once the page has painted.
  if(/^\/(dashboard|login)(\/|$)|\/app\.html$/.test(location.pathname)){
    var came=false;try{came=sessionStorage.getItem('cc_enter')==='1';sessionStorage.removeItem('cc_enter')}catch(e){}
    if(came){var go2=function(){var d=cover(false),t0=Date.now();var ready=function(){var a=document.querySelector('.authWrap');return document.querySelector('#root')&&document.querySelector('#root').children.length&&(!a||a.querySelector('.cardin'))};var wait=function(){if((ready()&&Date.now()-t0>260)||Date.now()-t0>8000){d.style.opacity='0';setTimeout(function(){d.remove()},420)}else setTimeout(wait,80)};wait()};if(document.body)go2();else document.addEventListener('DOMContentLoaded',go2)}
  }
})();
