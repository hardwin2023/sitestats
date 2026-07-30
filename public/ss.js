/* SiteStats 埋点脚本（自执行 + SPA 路由自动统计 + 暴露聚合函数给后台）
 * 接入：<script src="/ss.js" defer></script>  ——无需再手写 track() */
(function () {
  'use strict';
  var API = '/api/ss';
  var CFG = { storeKey:'ss_visits', uidKey:'ss_uid', sidKey:'ss_sid', maxRecords:3000, sessionGap:30*60*1000 };

  function rid(){ return Math.random().toString(36).slice(2,10); }
  function ls(k,v){ if(v===undefined){ try{ return localStorage.getItem(k); }catch(e){ return null; } } try{ localStorage.setItem(k,v); }catch(e){} }
  function keyOf(dt){ return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0'); }
  function dayKey(o){ var d=new Date(); d.setDate(d.getDate()-o); return keyOf(d); }
  function getUid(){ var u=ls(CFG.uidKey); if(!u){ u=rid()+rid(); ls(CFG.uidKey,u); } return u; }
  function getSession(){ var raw=ls(CFG.sidKey), now=Date.now(), s=null; try{ s=raw?JSON.parse(raw):null; }catch(e){}
    if(!s || now-s.last>CFG.sessionGap) s={ id:rid(), start:now }; s.last=now; ls(CFG.sidKey, JSON.stringify(s)); return s; }
  function getDevice(){ var ua=navigator.userAgent; if(/tablet|ipad/i.test(ua)) return 'tablet'; if(/mobi|android|iphone|ipod/i.test(ua)) return 'mobile'; return 'desktop'; }
  function getSource(){ var r=document.referrer; if(!r) return {t:'direct',l:'直接访问'}; var host='';
    try{ host=new URL(r).hostname; }catch(e){ return {t:'link',l:'外部链接'}; }
    if(host===location.hostname) return {t:'internal',l:'站内跳转'};
    var e=[['baidu','百度搜索'],['google','Google'],['bing','必应'],['sogou','搜狗'],['so.com','360搜索'],['duckduckgo','DuckDuckGo'],['yandex','Yandex']];
    for(var i=0;i<e.length;i++) if(host.indexOf(e[i][0])>-1) return {t:'search',l:e[i][1]};
    return {t:'link',l:host}; }
  function tzName(){ try{ return Intl.DateTimeFormat().resolvedOptions().timeZone||''; }catch(e){ return ''; } }
  function localLoad(){ try{ return JSON.parse(ls(CFG.storeKey)||'[]'); }catch(e){ return []; } }
  function saveLocal(l){ if(l.length>CFG.maxRecords) l=l.slice(-CFG.maxRecords); ls(CFG.storeKey, JSON.stringify(l)); }
  function post(url,obj){ var s=JSON.stringify(obj);
    try{ if(navigator.sendBeacon){ navigator.sendBeacon(url, new Blob([s],{type:'application/json'})); return; } }catch(e){}
    try{ fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:s,keepalive:true}); }catch(e){} }

  var _rec=null, _t0=Date.now(), _lastPath=null;
  function track(){
    if (location.pathname === _lastPath) return;
    _lastPath = location.pathname;
    var now=new Date(), src=getSource(), ses=getSession();
    _rec = { t:now.getTime(), d:keyOf(now), h:now.getHours(), p:location.pathname||'/', uid:getUid(), sid:ses.id,
      dev:getDevice(), st:src.t, sl:src.l, scr:screen.width+'×'+screen.height, lang:(navigator.language||'').slice(0,20), tz:tzName(), ua:navigator.userAgent, stay:0 };
    var l=localLoad(); l.push(_rec); saveLocal(l);
    post(API+'/report', _rec);
    var done=false;
    function flush(){ if(done) return; done=true; _rec.stay=Math.min(1800,Math.round((Date.now()-_t0)/1000));
      post(API+'/stay', { uid:_rec.uid, t:_rec.t, stay:_rec.stay });
      var ll=localLoad(); for(var i=ll.length-1;i>=0;i--) if(ll[i].t===_rec.t&&ll[i].uid===_rec.uid){ ll[i].stay=_rec.stay; break; } saveLocal(ll); }
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', function(){ if(document.visibilityState==='hidden') flush(); });
  }

  function hookSPA(){
    var wrap = function (m){ return function(){ var r = m.apply(history, arguments); dispatchEvent(new Event('ss:route')); return r; }; };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    addEventListener('popstate', function(){ dispatchEvent(new Event('ss:route')); });
    addEventListener('ss:route', function(){ setTimeout(track, 0); });
  }

  /* ---------- 聚合（后台 ss-admin.html 使用） ---------- */
  function daily(list,days){ var map={},i; for(i=0;i<days;i++) map[dayKey(i)]={pv:0,uv:{}};
    list.forEach(function(r){ if(map[r.d]){ map[r.d].pv++; map[r.d].uv[r.uid]=1; } });
    return Object.keys(map).sort().map(function(k){ return { d:k, pv:map[k].pv, uv:Object.keys(map[k].uv).length }; }); }
  function summary(list,days){ days=days||30; var today=dayKey(0), yest=dayKey(1), tPV=0,tUV={},yPV=0,allUV={},stays=[],recent=0,first={},rangeUV={};
    var cut=Date.now()-days*864e5;
    list.forEach(function(r){ allUV[r.uid]=1; if(first[r.uid]===undefined||r.t<first[r.uid]) first[r.uid]=r.t;
      if(r.d===today){ tPV++; tUV[r.uid]=1; } if(r.d===yest) yPV++;
      if(r.stay>1&&r.stay<1800) stays.push(r.stay); if(Date.now()-r.t<3e5) recent++; if(r.t>=cut) rangeUV[r.uid]=1; });
    var ruv=Object.keys(rangeUV).length, newCnt=0; Object.keys(rangeUV).forEach(function(u){ if(first[u]>=cut) newCnt++; });
    return { todayPV:tPV, todayUV:Object.keys(tUV).length, yesterdayPV:yPV, totalPV:list.length, totalUV:Object.keys(allUV).length,
      avgStay: stays.length?Math.round(stays.reduce(function(a,b){return a+b;},0)/stays.length):0, online:Math.max(recent,1),
      newRatio: ruv?Math.round(newCnt/ruv*100):0 }; }
  function hourly(list,days){ var cut=Date.now()-(days||30)*864e5, arr=new Array(24).fill(0); list.forEach(function(r){ if(r.t>=cut) arr[r.h]++; }); return arr; }
  function devices(list,days){ var cut=Date.now()-(days||30)*864e5, m={desktop:0,mobile:0,tablet:0};
    list.forEach(function(r){ if(r.t>=cut&&m[r.dev]!==undefined) m[r.dev]++; });
    return [{k:'desktop',l:'桌面端',v:m.desktop},{k:'mobile',l:'移动端',v:m.mobile},{k:'tablet',l:'平板',v:m.tablet}]; }
  function groupBy(list,days,key){ var cut=Date.now()-(days||30)*864e5, m={};
    list.forEach(function(r){ if(r.t>=cut){ var k=r[key]||'未知'; m[k]=(m[k]||0)+1; } });
    return Object.keys(m).map(function(k){ return {l:k,v:m[k]}; }).sort(function(a,b){return b.v-a.v;}).slice(0,6); }
  function sources(list,days){ return groupBy(list,days,'sl'); }
  function pages(list,days){ return groupBy(list,days,'p'); }
  function geo(list,days){ var cut=Date.now()-(days||30)*864e5, m={};
    list.forEach(function(r){ if(r.t<cut) return; var k=r.co||'未知'; if(!m[k]) m[k]={v:0,rg:{}}; m[k].v++; if(r.rg) m[k].rg[r.rg]=(m[k].rg[r.rg]||0)+1; });
    return Object.keys(m).map(function(k){ var top=Object.keys(m[k].rg).sort(function(a,b){return m[k].rg[b]-m[k].rg[a];}).slice(0,2);
      return { l:k, v:m[k].v, tip: top.length?(k+' · 主要在 '+top.join('、')):k }; }).sort(function(a,b){return b.v-a.v;}).slice(0,8); }

  function wpick(w){ var s=0,i; for(i=0;i<w.length;i++) s+=w[i]; var r=Math.random()*s; for(i=0;i<w.length;i++){ r-=w[i]; if(r<0) return i; } return w.length-1; }
  function seedDemo(){
    var pgs=['/','/posts/svg-charts','/posts/node-cli-notes','/about','/posts/css-grid-myths','/gallery','/posts/ffmpeg-cheat','/links'];
    var pw=[26,15,12,9,10,8,9,6], devW=[55,38,7];
    var srcs=[['direct','直接访问'],['search','百度搜索'],['search','Google搜索'],['link','github.com'],['internal','站内跳转'],['link','juejin.cn']];
    var srcW=[28,22,12,13,15,10], hw=[1,1,.5,.3,.3,.6,1.6,3,5,6.2,6.6,6,5.2,6.1,6.6,6,5.4,5,6,7,7.6,6.2,4,2.2];
    var scrs=['1920×1080','1366×768','1536×864','390×844','414×896','1280×720'];
    var geos=[['中国','上海','上海',24],['中国','北京','北京',17],['中国','广东','广州',8],['中国','广东','深圳',5],['中国','浙江','杭州',9],['中国','江苏','南京',5],['中国','江苏','苏州',3],['中国','四川','成都',5],['中国','湖北','武汉',3],['美国','加利福尼亚','洛杉矶',4],['美国','加利福尼亚','旧金山',2],['美国','纽约','纽约',3],['日本','东京','东京',6],['韩国','首尔','首尔',4],['中国香港','','香港',4],['新加坡','','新加坡',3],['英国','英格兰','伦敦',3],['德国','柏林','柏林',2],['法国','法兰西岛','巴黎',2],['加拿大','安大略','多伦多',2],['澳大利亚','新南威尔士','悉尼',2]];
    var gw=geos.map(function(g){return g[3];});
    var d2=[
      {os:'Windows 10/11',br:'Chrome 126',ua:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',w:22},
      {os:'Windows 10/11',br:'Edge 126',ua:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',w:8},
      {os:'macOS 14.5',br:'Safari 17.5',ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',w:7},
      {os:'macOS 14.5',br:'Chrome 126',ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',w:5},
      {os:'iOS 17.5',br:'Safari 17.5',ua:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',w:14},
      {os:'iOS 17.5',br:'WeChat 8.0',ua:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49',w:6},
      {os:'Android 14',br:'Chrome 126',ua:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',w:12},
      {os:'Android 13',br:'Samsung 25',ua:'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',w:4},
      {os:'Android 14',br:'Quark 7.0',ua:'Mozilla/5.0 (Linux; Android 14; V2324A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 Quark/7.0.0',w:3},
      {os:'Linux',br:'Firefox 127',ua:'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',w:3},
      {os:'iPadOS 17.5',br:'Safari 17.5',ua:'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',w:3},
      {os:'Windows 10/11',br:'Firefox 127',ua:'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',w:3}
    ];
    var d2W=d2.map(function(x){return x.w;});
    function fakeIp(){ return (1+Math.floor(Math.random()*222))+'.'+Math.floor(Math.random()*256)+'.'+Math.floor(Math.random()*256)+'.'+(1+Math.floor(Math.random()*254)); }
    var pool=[],i; for(i=0;i<170;i++) pool.push(rid()+rid());
    var out=[], now=new Date();
    for(var d=29;d>=0;d--){ var day=new Date(); day.setDate(now.getDate()-d);
      var wk=[.72,1.05,1.12,1.08,1.22,1.4,.95][day.getDay()]; var n=Math.round(88*wk+Math.random()*46+(29-d)*1.6);
      for(var j=0;j<n;j++){ var h=wpick(hw), t=new Date(day); t.setHours(h,Math.floor(Math.random()*60),Math.floor(Math.random()*60),0);
        if(t.getTime()>Date.now()) continue; var s=srcs[wpick(srcW)], g=geos[wpick(gw)], dv=d2[wpick(d2W)];
        out.push({ t:t.getTime(), d:keyOf(t), h:h, p:pgs[wpick(pw)],
          uid: Math.random()<.42? pool[Math.floor(Math.random()*pool.length)] : rid()+rid(),
          sid:rid(), dev:['desktop','mobile','tablet'][wpick(devW)], st:s[0], sl:s[1], scr:scrs[Math.floor(Math.random()*scrs.length)],
          lang:'zh-CN', tz:'Asia/Shanghai', co:g[0], rg:g[1], city:g[2], ip:fakeIp(), ua:dv.ua, os:dv.os, browser:dv.br, stay:Math.round(6+Math.random()*Math.random()*460) }); } }
    return out.sort(function(a,b){return a.t-b.t;});
  }

  window.SiteStats = { track:track, daily:daily, summary:summary, hourly:hourly, devices:devices, sources:sources, pages:pages, geo:geo, seedDemo:seedDemo, localLoad:localLoad, saveLocal:saveLocal };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  function init(){ track(); hookSPA(); }
})();