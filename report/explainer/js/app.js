(function(){
'use strict';
var E = window.Engine;
var $ = function(id){ return document.getElementById(id); };

// ------------------------------------------------ state
var P = { A:400, B:4, C:90, E:2.5, k:0.05 };
var CUR = { n:2, b:20 };
var OPT = { noise:2, per:5, seed:7, scale:'log' };
var SHOW = { samples:true, newton:true, contours:true };
var RES = {};

var PRESETS = {
  default:{A:400,B:4,C:90,E:2.5,k:0.05},
  rush:{A:950,B:3,C:120,E:2,k:0.04},
  tiny:{A:300,B:15,C:60,E:6,k:0.2},
  clash:{A:600,B:2,C:300,E:1.5,k:0.45}
};

var SL = [
  {id:'A', min:50, max:1000, step:10, label:'Queue pressure  A', hint:'How fast orders pile up when cooks are short', cls:'t-q'},
  {id:'B', min:0.5, max:20, step:0.1, label:'Crowding cost  B', hint:'Extra delay each additional cook causes', cls:'t-c'},
  {id:'C', min:10, max:500, step:5, label:'Batch setup cost  C', hint:'Oven warm-up paid once per batch', cls:'t-s'},
  {id:'E', min:0.5, max:20, step:0.1, label:'Batch wait cost  E', hint:'Waiting for each extra order to fill the batch', cls:'t-w'},
  {id:'k', min:0, max:0.5, step:0.01, label:'Clash  k', hint:'Cooks × batch size compete for counter space (memory)', cls:'t-k'}
];
var SL2 = [
  {id:'n', min:1, max:64, step:1, label:'Cooks now  n₀', hint:'Worker threads you run today', obj:'CUR'},
  {id:'b', min:1, max:64, step:1, label:'Batch now  b₀', hint:'Requests per batch you use today', obj:'CUR'}
];
var SL3 = [
  {id:'noise', min:0, max:10, step:0.5, label:'Measurement noise', hint:'Random error in each delay reading (± %)', obj:'OPT', unit:'%'},
  {id:'per', min:3, max:7, step:1, label:'Points per side', hint:'Measurements per round = points²', obj:'OPT'}
];

function fmt(x, d){ if(!isFinite(x)) return '—'; d = d==null?2:d; return Number(x).toFixed(d); }
function sig(x){ if(x===0) return '0'; var a=Math.abs(x); if(a<1e-3||a>=1e5) return x.toExponential(2); return x.toPrecision(4); }
function pct(x){ return (x*100).toFixed(Math.abs(x)<0.001?4:2)+'%'; }

function buildSliders(host, defs, getObj){
  host.innerHTML = '';
  defs.forEach(function(s){
    var o = getObj(s), wrap = document.createElement('div'); wrap.className='ctl';
    wrap.innerHTML = '<div class="row"><label class="'+(s.cls||'')+'">'+s.label+'</label><span class="val" id="v_'+s.id+'"></span></div>'+
      '<div class="hint">'+s.hint+'</div><input type="range" id="r_'+s.id+'" min="'+s.min+'" max="'+s.max+'" step="'+s.step+'" value="'+o[s.id]+'">';
    host.appendChild(wrap);
    var r = wrap.querySelector('input');
    var show = function(){ $('v_'+s.id).textContent = o[s.id] + (s.unit||''); };
    show();
    r.addEventListener('input', function(){ o[s.id] = parseFloat(r.value); show(); schedule(); });
  });
}
function syncSliders(){
  SL.forEach(function(s){ $('r_'+s.id).value = P[s.id]; $('v_'+s.id).textContent = P[s.id]; });
}
buildSliders($('sliders'), SL, function(){ return P; });
buildSliders($('sliders2'), SL2, function(){ return CUR; });
buildSliders($('sliders3'), SL3, function(){ return OPT; });

document.querySelectorAll('[data-preset]').forEach(function(btn){
  btn.addEventListener('click', function(){
    var k = btn.getAttribute('data-preset');
    if(k==='random'){
      var r = Math.random;
      P = { A:Math.round((50+r()*950)/10)*10, B:Math.round((0.5+r()*19.5)*10)/10, C:Math.round((10+r()*490)/5)*5,
            E:Math.round((0.5+r()*19.5)*10)/10, k:Math.round(r()*50)/100 };
    } else P = Object.assign({}, PRESETS[k]);
    buildSliders($('sliders'), SL, function(){ return P; });
    schedule();
  });
});
function toggle(id, key){ $(id).addEventListener('click', function(){ SHOW[key]=!SHOW[key]; $(id).classList.toggle('on', SHOW[key]); drawMap(); }); }
toggle('tgSamples','samples'); toggle('tgNewton','newton'); toggle('tgContours','contours');
$('scLog').addEventListener('click', function(){ OPT.scale='log'; $('scLog').classList.add('on'); $('scLin').classList.remove('on'); schedule(); });
$('scLin').addEventListener('click', function(){ OPT.scale='linear'; $('scLin').classList.add('on'); $('scLog').classList.remove('on'); schedule(); });
$('reMeasure').addEventListener('click', function(){ OPT.seed = 1 + Math.floor(Math.random()*99999); schedule(); });
document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click', function(){
    document.querySelectorAll('.tab').forEach(function(x){ x.classList.remove('active'); });
    document.querySelectorAll('.pane').forEach(function(x){ x.classList.remove('active'); });
    t.classList.add('active'); $(t.getAttribute('data-tab')).classList.add('active');
    if(t.getAttribute('data-tab')==='t5') drawSlices();
  });
});

// ------------------------------------------------ compute
var pending = false;
function schedule(){ if(pending) return; pending = true; requestAnimationFrame(function(){ pending=false; compute(); render(); }); }

function compute(){
  RES.newton = E.newton(P);
  RES.grid = E.gridSearch(P, {N:400, refines:5});
  RES.ours = E.ourMethod(P, {noise:OPT.noise/100, perSide:OPT.per, seed:OPT.seed, scale:OPT.scale});
  RES.closed = E.closedForm(P);
  RES.int = E.integerBest(P, RES.newton.n, RES.newton.b);
  RES.cur = E.D(P, CUR.n, CUR.b);
}

// ------------------------------------------------ map
var VIEW = { lo:0.5, hi:64 };
var L0 = Math.log2(VIEW.lo), L1 = Math.log2(VIEW.hi);
var M = { l:62, r:18, t:14, b:46 };
function colorFor(t){ // t in [0,1], 0 = best (bright mint), 1 = worst (dark)
  var stops = [[0,[214,255,236]],[0.08,[62,230,176]],[0.25,[30,160,170]],[0.5,[40,80,150]],[0.75,[45,40,105]],[1,[14,12,40]]];
  for(var i=1;i<stops.length;i++) if(t<=stops[i][0]){
    var a=stops[i-1], b=stops[i], f=(t-a[0])/(b[0]-a[0]);
    return [a[1][0]+(b[1][0]-a[1][0])*f, a[1][1]+(b[1][1]-a[1][1])*f, a[1][2]+(b[1][2]-a[1][2])*f];
  }
  return stops[stops.length-1][1];
}
var mapCache = null;
function drawMap(){
  var cv = $('map'), W = cv.width, H = cv.height, ctx = cv.getContext('2d');
  var pw = W - M.l - M.r, ph = H - M.t - M.b;
  ctx.clearRect(0,0,W,H);
  var Dmin = RES.newton.D;
  // heat
  var cell = 3, nx = Math.ceil(pw/cell), ny = Math.ceil(ph/cell);
  var vals = new Float64Array((nx+1)*(ny+1));
  for(var j=0;j<=ny;j++) for(var i=0;i<=nx;i++){
    var n = Math.pow(2, L0 + (L1-L0)*i/nx), b = Math.pow(2, L1 - (L1-L0)*j/ny);
    vals[j*(nx+1)+i] = E.D(P,n,b);
  }
  var img = ctx.createImageData(pw, ph);
  for(var y=0;y<ph;y++) for(var x=0;x<pw;x++){
    var v = vals[Math.min(ny, Math.round(y/cell))*(nx+1) + Math.min(nx, Math.round(x/cell))];
    var t = Math.min(1, Math.log(v/Dmin)/Math.log(6));
    var c = colorFor(Math.sqrt(Math.max(0,t))), k = (y*pw+x)*4;
    img.data[k]=c[0]; img.data[k+1]=c[1]; img.data[k+2]=c[2]; img.data[k+3]=255;
  }
  ctx.putImageData(img, M.l, M.t);
  // contours (marching squares)
  if(SHOW.contours){
    var levels = [1.02,1.05,1.1,1.2,1.4,1.7,2.2,3,4.5];
    ctx.lineWidth = 1;
    levels.forEach(function(lv, li){
      var L = Dmin*lv;
      ctx.strokeStyle = li<3 ? 'rgba(10,15,30,.55)' : 'rgba(255,255,255,.28)';
      ctx.beginPath();
      for(var j=0;j<ny;j++) for(var i=0;i<nx;i++){
        var a = vals[j*(nx+1)+i]-L, b2 = vals[j*(nx+1)+i+1]-L, c = vals[(j+1)*(nx+1)+i+1]-L, d = vals[(j+1)*(nx+1)+i]-L;
        var pts = [];
        function edge(p1,p2,x1,y1,x2,y2){ if((p1<0)!==(p2<0)){ var f=p1/(p1-p2); pts.push([x1+(x2-x1)*f, y1+(y2-y1)*f]); } }
        edge(a,b2,i,j,i+1,j); edge(b2,c,i+1,j,i+1,j+1); edge(c,d,i+1,j+1,i,j+1); edge(d,a,i,j+1,i,j);
        for(var q=0;q+1<pts.length;q+=2){
          ctx.moveTo(M.l+pts[q][0]*cell, M.t+pts[q][1]*cell); ctx.lineTo(M.l+pts[q+1][0]*cell, M.t+pts[q+1][1]*cell);
        }
      }
      ctx.stroke();
    });
  }
  // axes
  ctx.fillStyle = '#93a0c8'; ctx.font = '12px Segoe UI, sans-serif'; ctx.textAlign='center';
  ctx.strokeStyle = 'rgba(255,255,255,.15)';
  [0.5,1,2,4,8,16,32,64].forEach(function(v){
    var px = X(v), py = Y(v);
    ctx.fillText(v, px, H - M.b + 17);
    ctx.textAlign='right'; ctx.fillText(v, M.l - 8, py + 4); ctx.textAlign='center';
  });
  ctx.fillStyle='#cdd6ff'; ctx.font='600 13px Segoe UI, sans-serif';
  ctx.fillText('n = number of cooks (worker threads)  →', M.l + pw/2, H - 8);
  ctx.save(); ctx.translate(16, M.t + ph/2); ctx.rotate(-Math.PI/2); ctx.fillText('b = batch size  →', 0, 0); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(M.l, M.t, pw, ph); ctx.clip();
  // samples
  if(SHOW.samples){
    RES.ours.samples.forEach(function(s){
      var a = 0.25 + 0.75*(s.round+1)/RES.ours.rounds.length;
      dot(X(s.n), Y(s.b), 2.6, 'rgba(106,168,255,'+a.toFixed(2)+')');
    });
    RES.ours.rounds.forEach(function(r){
      ctx.strokeStyle = 'rgba(106,168,255,.35)'; ctx.lineWidth = 1;
      ctx.strokeRect(X(r.nLo), Y(r.bHi), X(r.nHi)-X(r.nLo), Y(r.bLo)-Y(r.bHi));
    });
  }
  if(SHOW.newton){
    ctx.strokeStyle = 'rgba(255,107,154,.9)'; ctx.lineWidth = 2; ctx.beginPath();
    RES.newton.path.forEach(function(s,i){ var px=X(s.n), py=Y(s.b); if(i) ctx.lineTo(px,py); else ctx.moveTo(px,py); });
    ctx.stroke();
    RES.newton.path.forEach(function(s){ dot(X(s.n), Y(s.b), 3.5, '#ff6b9a'); });
  }
  // current
  ring(X(CUR.n), Y(CUR.b), 7, '#ffb547', 3);
  // ours
  ring(X(RES.ours.n), Y(RES.ours.b), 8, '#6aa8ff', 3); dot(X(RES.ours.n), Y(RES.ours.b), 4, '#fff');
  // exact
  ring(X(RES.newton.n), Y(RES.newton.b), 12, '#3ee6b0', 2.5); dot(X(RES.newton.n), Y(RES.newton.b), 4.5, '#3ee6b0');
  ctx.restore();
  ctx.strokeStyle='#22305a'; ctx.lineWidth=1; ctx.strokeRect(M.l+.5, M.t+.5, pw, ph);

  function dot(x,y,r,c){ ctx.fillStyle=c; ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.fill(); }
  function ring(x,y,r,c,w){ ctx.strokeStyle=c; ctx.lineWidth=w; ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.stroke(); }
  function X(n){ return M.l + (Math.log2(n)-L0)/(L1-L0)*pw; }
  function Y(b){ return M.t + (1-(Math.log2(b)-L0)/(L1-L0))*ph; }
  mapCache = { pw:pw, ph:ph };
}
$('map').addEventListener('mousemove', function(ev){
  var cv = $('map'), rect = cv.getBoundingClientRect(), sx = cv.width/rect.width;
  var x = (ev.clientX-rect.left)*sx - M.l, y = (ev.clientY-rect.top)*sx - M.t;
  if(!mapCache || x<0||y<0||x>mapCache.pw||y>mapCache.ph){ $('tip').style.display='none'; return; }
  var n = Math.pow(2, L0 + (L1-L0)*x/mapCache.pw), b = Math.pow(2, L1 - (L1-L0)*y/mapCache.ph);
  var d = E.D(P,n,b), tip = $('tip');
  tip.innerHTML = 'n = '+fmt(n,2)+' cooks<br>b = '+fmt(b,2)+' per batch<br>D = <b>'+fmt(d,2)+' ms</b> ('+(d/RES.newton.D>1.0005?'+':'')+pct(d/RES.newton.D-1)+' vs best)';
  tip.style.display='block';
  var lx = ev.clientX-rect.left+14, ly = ev.clientY-rect.top+14;
  if(lx > rect.width-200) lx -= 220;
  tip.style.left = lx+'px'; tip.style.top = ly+'px';
});
$('map').addEventListener('mouseleave', function(){ $('tip').style.display='none'; });

// ------------------------------------------------ panels
function render(){
  var nw = RES.newton, o = RES.ours;
  $('sN').textContent = fmt(nw.n,2); $('sB').textContent = fmt(nw.b,2); $('sD').textContent = fmt(nw.D,2);
  var imp = 1 - nw.D/RES.cur;
  $('sImp').textContent = (imp*100).toFixed(1)+'%';
  $('sImpS').textContent = 'your setting: '+fmt(RES.cur,1)+' ms → '+fmt(nw.D,1)+' ms';
  $('sInt').textContent = RES.int.n+' × '+RES.int.b;
  $('sIntS').textContent = fmt(RES.int.D,2)+' ms (only +'+pct(RES.int.D/nw.D-1)+')';
  drawMap(); renderBars(); renderCalc(); renderOurs(); renderProof();
  if($('t5').classList.contains('active')) drawSlices();
}

function renderBars(){
  var nw = RES.newton;
  var rows = [['Your setting (n₀='+CUR.n+', b₀='+CUR.b+')', E.terms(P,CUR.n,CUR.b), RES.cur], ['Best setting (n*='+fmt(nw.n,2)+', b*='+fmt(nw.b,2)+')', E.terms(P,nw.n,nw.b), nw.D]];
  var max = Math.max(rows[0][2], rows[1][2]);
  var cols = {queue:'#6aa8ff', crowd:'#ff6b9a', setup:'#ffb547', wait:'#a98bff', clash:'#ff5d5d'};
  var names = {queue:'A/n', crowd:'B·n', setup:'C/b', wait:'E·b', clash:'k·n·b'};
  var h = '';
  rows.forEach(function(r){
    h += '<div style="margin:12px 0 2px"><b>'+r[0]+'</b>  <span class="pill">'+fmt(r[2],2)+' ms</span></div><div class="bar" style="width:'+(100*r[2]/max).toFixed(2)+'%">';
    Object.keys(cols).forEach(function(k){
      var w = 100*r[1][k]/r[2]; if(w<=0) return;
      h += '<div title="'+names[k]+' = '+fmt(r[1][k],2)+' ms" style="width:'+w.toFixed(2)+'%;background:'+cols[k]+'">'+(w>9?names[k]+' '+fmt(r[1][k],0):'')+'</div>';
    });
    h += '</div>';
  });
  $('bars').innerHTML = h;
  var t = E.terms(P,nw.n,nw.b);
  $('barsNote').innerHTML = 'At the best setting, A/n = '+fmt(t.queue,2)+' and B·n + k·n·b = '+fmt(t.crowd+t.clash,2)+'. These are equal, which is exactly what ∂D/∂n = 0 says: n·∂D/∂n = −A/n + B·n + k·n·b = 0. '+
    'The same balance holds for batches: C/b = '+fmt(t.setup,2)+' and E·b + k·n·b = '+fmt(t.wait+t.clash,2)+'. <b>At the sweet spot, the costs that fall exactly balance the costs that rise.</b>';
}

function renderCalc(){
  var nw = RES.newton, c = RES.closed;
  $('eqs').innerHTML = '−'+P.A+'/n² + '+P.B+' + '+P.k+'·b = 0<br>−'+P.C+'/b² + '+P.E+' + '+P.k+'·n = 0';
  $('closed').innerHTML = 'n* = √(A/B) = √('+P.A+'/'+P.B+') = '+fmt(c.n,4)+'<br>b* = √(C/E) = √('+P.C+'/'+P.E+') = '+fmt(c.b,4);
  $('kNote').innerHTML = P.k===0 ? '<span class="ok">Here k = 0, so this is already the exact answer.</span>' :
    'Here k = '+P.k+' ≠ 0, so each equation contains the other knob. They are <b>coupled non-linear equations</b>, and we solve them with Newton\'s method →';
  var h = '<tr><th>step</th><th>n</th><th>b</th><th>D (ms)</th><th>|∇D|</th><th class="l">move</th></tr>';
  nw.path.forEach(function(s){
    h += '<tr><td>'+s.it+'</td><td>'+fmt(s.n,6)+'</td><td>'+fmt(s.b,6)+'</td><td>'+fmt(s.D,6)+'</td><td>'+s.gnorm.toExponential(2)+'</td><td class="l">'+(s.step?s.step+(s.t<1?' (½-step)':''):'<span class="ok">converged</span>')+'</td></tr>';
  });
  $('newtonTbl').innerHTML = h;
  var H = nw.H, ev = nw.eig, pd = ev[0]>0;
  $('hessBox').innerHTML =
    '<div class="m" style="white-space:normal">H(n*,b*) = <span class="matrix" style="grid-template-columns:auto auto"><span>'+sig(H[0][0])+'</span><span>'+sig(H[0][1])+'</span><span>'+sig(H[1][0])+'</span><span>'+sig(H[1][1])+'</span></span>'+
    '   with  D<sub>nn</sub> = 2A/n³,  D<sub>nb</sub> = k,  D<sub>bb</sub> = 2C/b³</div>'+
    '<div class="m">D<sub>nn</sub> = '+sig(H[0][0])+' &gt; 0   ·   det H = '+sig(nw.det)+(nw.det>0?' &gt; 0':' ≤ 0')+'</div>'+
    '<div class="m">eigenvalues λ = (tr H ± √(tr²H − 4·det H))/2  →  λ₁ = '+sig(ev[0])+',  λ₂ = '+sig(ev[1])+'</div>'+
    '<div class="m">gradient at answer |∇D| = '+nw.gnorm.toExponential(2)+'  (zero up to computer rounding)</div>'+
    '<p><span class="verdict '+(pd?'ok':'bad')+'">'+(pd?'✓ Both eigenvalues positive → positive-definite quadratic form → TRUE MINIMUM':'✗ Not positive definite')+'</span></p>';
}

function renderOurs(){
  var o = RES.ours, nw = RES.newton;
  $('seedPill').textContent = 'seed '+OPT.seed;
  var gap = o.D/nw.D - 1, pos = Math.hypot(o.n/nw.n-1, o.b/nw.b-1);
  var good = gap < 0.01;
  $('oursResult').innerHTML =
    '<table><tr><th class="l"></th><th>n</th><th>b</th><th>delay (ms)</th></tr>'+
    '<tr><td class="l">Our method (noisy data only)</td><td>'+fmt(o.n,3)+'</td><td>'+fmt(o.b,3)+'</td><td>'+fmt(o.D,3)+'</td></tr>'+
    '<tr><td class="l">Exact (calculus)</td><td>'+fmt(nw.n,3)+'</td><td>'+fmt(nw.b,3)+'</td><td>'+fmt(nw.D,3)+'</td></tr></table>'+
    '<p style="margin:10px 0 4px">Extra delay vs the true best: <span class="'+(good?'ok':'warn')+'">'+pct(gap)+'</span> · position off by '+pct(pos)+'</p>'+
    '<p class="small" style="margin:0">Used <b>'+o.measurements+'</b> measurements in '+o.rounds.length+' rounds. Stopped because: '+o.stopReason+'.'+
    (OPT.noise>0?' Near the bottom the bowl is very flat, so a small error in position costs almost nothing in delay. That is why the delay gap is much smaller than the position error.':'')+'</p>';
  var h = '<tr><th>round</th><th>n window</th><th>b window</th><th>readings</th><th>R²</th><th>fitted n</th><th>fitted b</th><th>eigenvalues of fitted H</th><th class="l">bowl?</th><th class="l">decision</th></tr>';
  o.rounds.forEach(function(r){
    var f = r.fit;
    h += '<tr><td>'+r.round+'</td><td>'+fmt(r.nLo,2)+' – '+fmt(r.nHi,2)+'</td><td>'+fmt(r.bLo,2)+' – '+fmt(r.bHi,2)+'</td><td>'+r.count+'</td>'+
      '<td>'+(f?fmt(f.r2,4):'—')+'</td><td>'+(f?fmt(f.n,3):'—')+'</td><td>'+(f?fmt(f.b,3):'—')+'</td>'+
      '<td>'+(f?sig(f.eigScaled[0])+', '+sig(f.eigScaled[1]):'—')+'</td><td class="l">'+(f&&f.pd?'<span class="ok">yes</span>':'<span class="bad">no</span>')+'</td><td class="l">'+r.action+'</td></tr>';
  });
  $('roundsTbl').innerHTML = h;
  var f = o.lastFit;
  if(f){
    var names = ['1','u','v','u²','uv','v²'];
    var mt = '<div class="tblwrap"><table style="max-width:760px"><tr><th class="l">XᵀX</th>'+names.map(function(x){return '<th>'+x+'</th>';}).join('')+'<th>Xᵀy</th><th>solution c</th></tr>';
    for(var i=0;i<6;i++){ mt += '<tr><td class="l">'+names[i]+'</td>'+f.XtX[i].map(function(v){return '<td>'+sig(v)+'</td>';}).join('')+'<td>'+sig(f.Xty[i])+'</td><td class="ok">'+sig(f.c[i])+'</td></tr>'; }
    mt += '</table></div>';
    $('lsBox').innerHTML = '<p>The fitted bowl is Q(u,v) = c₀ + c₁u + c₂v + c₃u² + c₄uv + c₅v², where u and v are the knobs on the '+(OPT.scale==='log'?'log (doubling)':'ordinary')+' scale, centred and scaled to the window. '+
      'We find the six c values by solving the <b>normal equations</b> (XᵀX)·c = Xᵀy with Gaussian elimination:</p>'+mt+
      '<p>Then the bottom of the bowl solves <span class="mi">[2c₃ c₄; c₄ 2c₅]·[u v]ᵀ = −[c₁ c₂]ᵀ</span>. Its Hessian eigenvalues are '+sig(f.eigScaled[0])+' and '+sig(f.eigScaled[1])+', both '+(f.pd?'positive → a real bowl ✓':'not positive')+
      '. Rescaling the knobs only multiplies by positive numbers, so it never changes the signs of the eigenvalues (Sylvester\'s law of inertia).</p>';
  } else $('lsBox').innerHTML = '<p>No trusted bowl-shaped fit in this run.</p>';
}

function renderProof(){
  var nw = RES.newton, g = RES.grid, o = RES.ours;
  function gn(n,b){ var v = E.grad(P,n,b); return Math.hypot(v[0],v[1]); }
  var rows = [
    ['Newton\'s method (calculus + 2×2 linear solve)', nw.n, nw.b, nw.D, gn(nw.n,nw.b), nw.path.length-1+' iterations'],
    ['Brute-force grid search (no calculus at all)', g.n, g.b, g.D, gn(g.n,g.b), g.evals.toLocaleString()+' evaluations'],
    ['Our Log-Scale Bowl Search (noisy measurements only)', o.n, o.b, o.D, gn(o.n,o.b), o.measurements+' noisy readings']
  ];
  var h = '<tr><th class="l">Method</th><th>n*</th><th>b*</th><th>D* (ms)</th><th>|∇D| there</th><th>work done</th></tr>';
  rows.forEach(function(r){ h += '<tr><td class="l">'+r[0]+'</td><td>'+fmt(r[1],6)+'</td><td>'+fmt(r[2],6)+'</td><td>'+fmt(r[3],6)+'</td><td>'+r[4].toExponential(2)+'</td><td>'+r[5]+'</td></tr>'; });
  $('proofTbl').innerHTML = h;
  var d1 = Math.hypot(nw.n/g.n-1, nw.b/g.b-1), lower = g.D < nw.D*(1-1e-12);
  $('proofNote').innerHTML = 'Newton vs brute force: positions differ by '+d1.toExponential(1)+' (relative). Brute force found '+
    (lower?'<span class="bad">a lower point</span>':'<span class="ok">no lower point anywhere from 0.05 to 500 on both knobs</span>')+'. '+
    'Our method, working only from '+(OPT.noise)+'%-noisy readings, lands within <b>'+pct(o.D/nw.D-1)+'</b> of the best possible delay.';
}

$('runSelf').addEventListener('click', function(){
  $('selfOut').innerHTML = '<span class="small">Running…</span>';
  setTimeout(function(){
    var t0 = performance.now(), r = E.selfTest(200, 1 + Math.floor(Math.random()*1e6)), ms = performance.now()-t0;
    $('selfOut').innerHTML = '<div class="m"><span class="'+(r.pass===r.count?'ok':'bad')+'">'+r.pass+' / '+r.count+' passed</span> · worst position gap '+r.worstPositionGap.toExponential(1)+' · '+ms.toFixed(0)+' ms</div>'+
      '<p class="small">For each random server: Newton converged ✓, both Hessian eigenvalues positive ✓, and a ~100,000-point brute-force search found nothing lower ✓.</p>';
  }, 30);
});
$('runScale').addEventListener('click', function(){
  $('scaleOut').innerHTML = '<span class="small">Running 600 full searches…</span>';
  setTimeout(function(){
    var nz = OPT.noise/100, r = E.scaleExperiment(300, nz, 1 + Math.floor(Math.random()*1e6));
    function row(name, x, cls){ return '<tr><td class="l">'+name+'</td><td class="'+cls+'">'+x.ok+' / 300</td><td>'+pct(x.median)+'</td><td>'+pct(x.worst)+'</td></tr>'; }
    $('scaleOut').innerHTML = '<table><tr><th class="l">Scale</th><th>within 1% of best</th><th>median extra delay</th><th>worst extra delay</th></tr>'+
      row('Ordinary scale (n, b)', r.linear, r.linear.ok<r.log.ok?'bad':'')+row('Log scale (ln n, ln b): ours', r.log, 'ok')+'</table>'+
      '<p class="small">Noise used: '+OPT.noise+'% (change it with the slider in tab ③). Same servers, same measurement budget, same code. The only difference is the scale.</p>';
  }, 30);
});

// ------------------------------------------------ slices
function drawSlice(id, fn, xOpt, other, label){
  var cv = $(id), ctx = cv.getContext('2d'), W = cv.width, H = cv.height, m = {l:52,r:14,t:12,b:34};
  var pw = W-m.l-m.r, ph = H-m.t-m.b; ctx.clearRect(0,0,W,H);
  var xs = [], ys = [], N = 300, l0 = Math.log2(0.5), l1 = Math.log2(64);
  for(var i=0;i<=N;i++){ var x = Math.pow(2, l0+(l1-l0)*i/N); xs.push(x); ys.push(fn(x)); }
  var yMin = fn(xOpt), yMax = Math.min(Math.max.apply(null, ys), yMin*3);
  var X = function(x){ return m.l + (Math.log2(x)-l0)/(l1-l0)*pw; };
  var Y = function(y){ return m.t + (1-(y-yMin*0.95)/(yMax-yMin*0.95))*ph; };
  ctx.strokeStyle='#22305a'; ctx.strokeRect(m.l+.5,m.t+.5,pw,ph);
  ctx.fillStyle='#93a0c8'; ctx.font='11px Segoe UI, sans-serif'; ctx.textAlign='center';
  [0.5,1,2,4,8,16,32,64].forEach(function(v){ ctx.fillText(v, X(v), H-m.b+15); });
  ctx.fillText(label, m.l+pw/2, H-4);
  ctx.textAlign='right';
  for(var q=0;q<=4;q++){ var yv = yMin*0.95 + (yMax-yMin*0.95)*q/4; ctx.fillText(yv.toFixed(0), m.l-6, Y(yv)+4); }
  ctx.save(); ctx.beginPath(); ctx.rect(m.l,m.t,pw,ph); ctx.clip();
  ctx.strokeStyle='#6aa8ff'; ctx.lineWidth=2.5; ctx.beginPath();
  xs.forEach(function(x,i){ var px=X(x), py=Y(ys[i]); if(i) ctx.lineTo(px,py); else ctx.moveTo(px,py); }); ctx.stroke();
  ctx.setLineDash([6,5]); ctx.strokeStyle='#3ee6b0'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(m.l, Y(yMin)); ctx.lineTo(m.l+pw, Y(yMin)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle='#3ee6b0'; ctx.beginPath(); ctx.arc(X(xOpt), Y(yMin), 5, 0, 7); ctx.fill();
  ctx.restore();
  ctx.fillStyle='#3ee6b0'; ctx.textAlign='left'; ctx.font='600 12px Segoe UI, sans-serif';
  ctx.fillText('flat tangent: slope = 0', Math.min(X(xOpt)+8, W-150), Y(yMin)-8);
}
function drawSlices(){
  var nw = RES.newton;
  drawSlice('sliceN', function(n){ return E.D(P,n,nw.b); }, nw.n, nw.b, 'n (cooks), doubling scale');
  drawSlice('sliceB', function(b){ return E.D(P,nw.n,b); }, nw.b, nw.n, 'b (batch size), doubling scale');
  var g = E.grad(P, nw.n, nw.b), H = nw.H;
  $('sliceNNote').innerHTML = 'At n* = '+fmt(nw.n,3)+': slope ∂D/∂n = '+g[0].toExponential(1)+' (≈ 0), curvature ∂²D/∂n² = '+sig(H[0][0])+' &gt; 0, so the curve bends upward: a minimum.';
  $('sliceBNote').innerHTML = 'At b* = '+fmt(nw.b,3)+': slope ∂D/∂b = '+g[1].toExponential(1)+' (≈ 0), curvature ∂²D/∂b² = '+sig(H[1][1])+' &gt; 0, so the curve bends upward: a minimum.';
}

compute(); render();
})();
