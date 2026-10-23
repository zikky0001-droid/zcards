// stats-app.js  

'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const fmt = n => Number(n || 0).toLocaleString();
  const num = value => { const m = String(value ?? '').match(/[\d.]+/); return m ? Number(m[0]) : 0; };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isStudio = location.pathname.endsWith('stats-chart.html');
  const query = new URLSearchParams(location.search);
  const chartTypes = {
    traffic: {title:'Traffic waveform',desc:'Request volume over time',kind:'line',kicker:'A1 / REQUEST TELEMETRY'},
    health: {title:'Response health',desc:'Successful and failed responses',kind:'doughnut',kicker:'A2 / RESPONSE RELIABILITY'},
    latency: {title:'Latency distribution',desc:'Aggregated average-latency observations by band',kind:'bar',kicker:'A3 / LATENCY OBSERVATIONS'},
    endpoints: {title:'Endpoint performance',desc:'Route-level request ranking',kind:'bar',kicker:'A4 / ROUTE PERFORMANCE'}
  };
  const palette = {cyan:'#63f3ff',blue:'#5f91ff',violet:'#a78bfa',magenta:'#fa70d6',green:'#65f6b5',pink:'#ff729c',muted:'#8d9bb9'};
  let apiKey = sessionStorage.getItem('shoob-admin-key') || '';
  let knownEndpoints = [];
  let selectedEndpoints = [];
  let endpointApplied = false;
  let currentRange = 'today';
  let charts = {};
  let refreshTimer = null;
  let refreshing = false;
  let lastRows = [];
  let lastDataStamp = '';
  let activeWindow = null;
  let toastTimer;

  function toast(message, kind='good') {
    const el = $('toast'); if (!el) return;
    el.textContent = message; el.className = `toast show ${kind}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, 3600);
  }
  function dateISO(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
  function startOfWeek(date) { const d = new Date(date); const dow = (d.getDay()+6)%7; d.setDate(d.getDate()-dow); d.setHours(0,0,0,0); return d; }
  function minAllowedDate() { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()-2); d.setHours(0,0,0,0); return d; }
  function today() { const d = new Date(); d.setHours(0,0,0,0); return d; }
  function dateWindow() {
    if (!$('dateFrom') || !$('dateTo')) return activeWindow || {from:dateISO(today()),to:dateISO(today())};
    const end = $('dateTo').value || dateISO(today());
    const start = $('dateFrom').value || end;
    return {from:start,to:end};
  }
  function setWindow(from, to, preset) {
    const min = dateISO(minAllowedDate()); const max = dateISO(today());
    let safeFrom = from < min ? min : from > max ? max : from;
    let safeTo = to < min ? min : to > max ? max : to;
    if (safeFrom > safeTo) safeFrom = safeTo;
    activeWindow = {from:safeFrom,to:safeTo};
    if ($('dateFrom') && $('dateTo')) { $('dateFrom').value=safeFrom; $('dateTo').value=safeTo; $('dateFrom').min=min; $('dateFrom').max=max; $('dateTo').min=min; $('dateTo').max=max; }
    currentRange = preset || 'custom';
    document.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('active', b.dataset.range === currentRange));
    const note = $('rangeNote'); if (note) note.querySelector('span').textContent = `Available window: ${min} to ${max}. Data is stored using the Africa/Lagos calendar.`;
    updateFilterSummary();
  }
  function applyPreset(preset) {
    const now = today(); let start = new Date(now); const end = dateISO(now);
    if (preset === 'week') start = startOfWeek(now);
    else if (preset === 'month') start = new Date(now.getFullYear(),now.getMonth(),1);
    else if (preset === 'custom') { currentRange='custom'; document.querySelectorAll('[data-range]').forEach(b=>b.classList.toggle('active',b.dataset.range==='custom')); return; }
    setWindow(dateISO(start),end,preset); void refreshData();
  }
  function normalizeEndpointInput() { return ($('endpointInput')?.value || '').split(',').map(x=>x.trim()).filter(Boolean); }
  function validateEndpointInput() {
    if (!$('endpointInput')) return;
    const raw = $('endpointInput').value.trim(); const paths = normalizeEndpointInput();
    const line = $('endpointHelp')?.parentElement; const btn = $('endpointSearch');
    const allKnown = paths.length > 0 && paths.every(path => knownEndpoints.includes(path));
    const duplicates = new Set(paths).size !== paths.length;
    const valid = allKnown && !duplicates;
    if (btn) btn.disabled = !valid;
    if (!raw) {
      line?.classList.remove('valid','invalid');
      $('validationIcon').textContent='◇'; $('endpointHelp').textContent='Leave blank to view all tracked endpoints, or enter a route to validate it.';
      $('matchedCount').textContent=''; return;
    }
    if (valid) {
      line?.classList.add('valid'); line?.classList.remove('invalid');
      $('validationIcon').textContent='✓'; $('endpointHelp').textContent=paths.length===1?'Endpoint verified in the API directory. Search is ready.':`${paths.length} endpoints verified in the API directory. Search is ready.`;
      $('matchedCount').textContent=`${paths.length}/${paths.length} MATCHED`;
    } else {
      line?.classList.add('invalid'); line?.classList.remove('valid');
      $('validationIcon').textContent='×';
      const bad = paths.filter(path=>!knownEndpoints.includes(path));
      $('endpointHelp').textContent=duplicates?'Remove duplicate routes.':bad.length?`Not found: ${bad.join(', ')}. Choose an exact route from the suggestions.`:'Enter one or more exact endpoint paths.';
      $('matchedCount').textContent=`${paths.length-bad.length}/${paths.length} MATCHED`;
    }
  }
  function updateFilterSummary() {
    if (!$('filterSummary')) return;
    const range = dateWindow(); const label = currentRange==='today'?'Today':currentRange==='week'?'This week':currentRange==='month'?'This month':`${range.from} → ${range.to}`;
    const ep = endpointApplied && selectedEndpoints.length ? selectedEndpoints.join(', ') : 'All tracked endpoints';
    $('filterSummary').textContent = `${ep} · ${label}`;
  }
  async function getJson(url) {
    const join = url.includes('?') ? '&' : '?';
    const full = apiKey ? `${url}${join}key=${encodeURIComponent(apiKey)}` : url;
    const res = await fetch(full,{cache:'no-store',headers:{'Accept':'application/json'}});
    let data={}; try { data=await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  async function loadDirectory() {
    try {
      const d = await getJson('/api/endpoints');
      const omit = new Set(['/','/ping','/api/health','/api/endpoints','/api/endpoint','/api/stats']);
      knownEndpoints = [...new Set((d.endpoints||[]).map(x=>x.path).filter(p=>p && p.startsWith('/api/') && !omit.has(p)))].sort();
      if ($('endpointOptions')) $('endpointOptions').innerHTML = knownEndpoints.map(p=>`<option value="${esc(p)}"></option>`).join('');
      validateEndpointInput();
    } catch (e) { toast(`Could not load endpoint directory: ${e.message}`,'error'); }
  }
  function endpointQuery(path) { return `&endpoint=${encodeURIComponent(path)}`; }
  async function fetchRows() {
    const endpoints = endpointApplied ? selectedEndpoints : [];
    const requests = endpoints.length ? endpoints.map(path=>getJson('/api/stats?daily=true'+endpointQuery(path))) : [getJson('/api/stats?daily=true')];
    const results = await Promise.all(requests);
    const merged = new Map();
    for (const result of results) {
      if (!result.ok) throw new Error(result.error || 'Stats API returned an error');
      for (const row of (result.daily||[])) {
        const key = [row.grain,row.method,row.path,row.param_sig].join('|');
        if (merged.has(key)) {
          const old=merged.get(key); old.total+=Number(row.total||0); old.ok+=Number(row.ok||0); old.err+=Number(row.err||0);
          old._latencyWeighted += num(row.avg_time)*Number(row.total||0); old._latencyWeight += Number(row.total||0); old._max=Math.max(old._max,num(row.max_time));
        } else merged.set(key,{...row,total:Number(row.total||0),ok:Number(row.ok||0),err:Number(row.err||0),_latencyWeighted:num(row.avg_time)*Number(row.total||0),_latencyWeight:Number(row.total||0),_max:num(row.max_time)});
      }
    }
    return [...merged.values()].map(row=>({...row,avgMs:row._latencyWeight?row._latencyWeighted/row._latencyWeight:0,maxMs:row._max||num(row.max_time)}));
  }
  function filteredRows(rows) {
    const {from,to}=dateWindow();
    return rows.filter(r => String(r.grain||'')>=from && String(r.grain||'')<=to);
  }
  function summarize(rows) {
    let total=0,ok=0,err=0,weighted=0,weight=0,max=0;
    const routes=new Map(); const days=new Map(); const latencyObs=[];
    for (const r of rows) {
      total+=r.total; ok+=r.ok; err+=r.err; weighted+=r.avgMs*r.total; weight+=r.total; max=Math.max(max,r.maxMs);
      const route=routes.get(r.path)||{path:r.path,total:0,ok:0,err:0,weighted:0,weight:0,max:0};
      route.total+=r.total;route.ok+=r.ok;route.err+=r.err;route.weighted+=r.avgMs*r.total;route.weight+=r.total;route.max=Math.max(route.max,r.maxMs);routes.set(r.path,route);
      const day=days.get(r.grain)||{total:0,ok:0,err:0};day.total+=r.total;day.ok+=r.ok;day.err+=r.err;days.set(r.grain,day);
      if (r.total>0) latencyObs.push({ms:r.avgMs,weight:1});
    }
    return {total,ok,err,avg:weight?weighted/weight:0,max,routes:[...routes.values()].map(r=>({...r,avg:r.weight?r.weighted/r.weight:0})).sort((a,b)=>b.total-a.total),days:[...days.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,v])=>({date,...v})),latencyObs};
  }
  function chartBaseOptions(extra={}) {
    const light=document.documentElement.classList.contains('light-theme'); const grid=light?'rgba(60,80,125,.12)':'rgba(141,160,204,.12)'; const ticks=light?'#687794':'#8090b2';
    return {responsive:true,maintainAspectRatio:false,animation:false,interaction:{intersect:false,mode:'index'},plugins:{legend:{display:false},tooltip:{backgroundColor:light?'#fff':'#0d1428',titleColor:light?'#1b2947':'#eaf1ff',bodyColor:light?'#4d5d7b':'#aab9d9',borderColor:light?'rgba(60,80,125,.18)':'rgba(99,243,255,.24)',borderWidth:1,padding:11,displayColors:true}},scales:{x:{grid:{color:grid},ticks:{color:ticks,maxRotation:0,autoSkip:true,maxTicksLimit:10,font:{family:'DM Mono',size:9}},border:{color:grid}},y:{beginAtZero:true,grid:{color:grid},ticks:{color:ticks,font:{family:'DM Mono',size:9}},border:{display:false}}},...extra};
  }
  function zoomOptions() { return {zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'x'},pan:{enabled:true,mode:'x'}}; }
  function createChart(id,type,data,options={}) {
    const canvas=$(id); if (!canvas || !window.Chart) return null;
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    let config;
    if (type==='traffic') config={type:'line',data:{labels:data.labels,datasets:[{label:'Requests',data:data.values,borderColor:palette.cyan,backgroundColor:'rgba(99,243,255,.10)',fill:true,borderWidth:2.3,tension:.35,pointRadius:data.labels.length>45?0:2.5,pointHoverRadius:5,pointBackgroundColor:palette.cyan,pointBorderWidth:0}]},options:chartBaseOptions({plugins:{...chartBaseOptions().plugins,zoom:zoomOptions()},scales:{x:chartBaseOptions().scales.x,y:{...chartBaseOptions().scales.y,ticks:{...chartBaseOptions().scales.y.ticks,precision:0}}}})};
    else if (type==='health') config={type:'doughnut',data:{labels:['Successful','Failed'],datasets:[{data:data.values,backgroundColor:[palette.green,palette.pink],borderColor:['rgba(101,246,181,.7)','rgba(255,114,156,.7)'],borderWidth:1,hoverOffset:7,spacing:3}]},options:{responsive:true,maintainAspectRatio:false,cutout:'76%',plugins:{legend:{display:false},tooltip:chartBaseOptions().plugins.tooltip}}};
    else if (type==='latency') config={type:'bar',data:{labels:data.labels,datasets:[{label:'Observations',data:data.values,backgroundColor:['rgba(99,243,255,.5)','rgba(95,145,255,.55)','rgba(167,139,250,.65)','rgba(250,112,214,.65)','rgba(255,114,156,.7)'],borderColor:[palette.cyan,palette.blue,palette.violet,palette.magenta,palette.pink],borderWidth:1,borderRadius:7,maxBarThickness:48}]},options:chartBaseOptions({plugins:{...chartBaseOptions().plugins,zoom:zoomOptions()}})};
    else config={type:'bar',data:{labels:data.labels,datasets:[{label:'Requests',data:data.values,backgroundColor:data.labels.map((_,i)=>i===0?'rgba(99,243,255,.7)':'rgba(250,112,214,.48)'),borderColor:data.labels.map((_,i)=>i===0?palette.cyan:palette.magenta),borderWidth:1,borderRadius:6,maxBarThickness:34}]},options:chartBaseOptions({indexAxis:'y',plugins:{...chartBaseOptions().plugins,zoom:{zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'y'},pan:{enabled:true,mode:'y'}},legend:{display:false}}})};
    charts[id]=new Chart(canvas,config); return charts[id];
  }
  function updateChart(id,data) {
    const c=charts[id]; if (!c) return;
    c.data.labels=data.labels;
    c.data.datasets.forEach((ds,i)=>{ds.data=data.datasets[i]||[]; if(data.colors)ds.backgroundColor=data.colors;});
    c.update('none');
  }
  function setMetric(summary) {
    if (!$('totalRequests')) return;
    $('totalRequests').textContent=fmt(summary.total); $('successRate').innerHTML=`${summary.total?(summary.ok/summary.total*100).toFixed(1):'—'}<small>%</small>`;
    $('successCount').textContent=`${fmt(summary.ok)} successful`; $('failedCount').textContent=fmt(summary.err); $('failureRate').textContent=`${summary.total?(summary.err/summary.total*100).toFixed(1):'—'}% failure rate`;
    $('avgLatency').innerHTML=`${summary.total?Math.round(summary.avg):'—'}<small>ms</small>`; $('maxLatency').textContent=`Peak ${summary.total?Math.round(summary.max)+' ms':'—'}`;
    $('successTrack').style.width=`${summary.total?summary.ok/summary.total*100:0}%`; $('failureTrack').style.width=`${summary.total?summary.err/summary.total*100:0}%`; $('pieTotal').textContent=fmt(summary.total);
  }
  function tableRows(routes) {
    const body=$('endpointTable'); if(!body)return;
    $('routeCount').textContent=`${routes.length} ROUTES`;
    if (!routes.length) {body.innerHTML='<tr><td colspan="5" class="empty-cell">No request data exists for this selection and date window.</td></tr>';return;}
    body.innerHTML=routes.slice(0,12).map(r=>`<tr><td class="endpoint-cell">${esc(r.path)}</td><td class="num-cell">${fmt(r.total)}</td><td class="success-cell">${r.total?(r.ok/r.total*100).toFixed(1)+'%':'—'}</td><td class="num-cell">${r.total?Math.round(r.avg)+' ms':'—'}</td><td class="num-cell">${r.total?Math.round(r.max)+' ms':'—'}</td></tr>`).join('');
  }
  function buildChartData(summary) {
    const days=summary.days; const traffic={labels:days.map(x=>x.date),values:days.map(x=>x.total)};
    const bands=[{label:'0–50 ms',min:0,max:50},{label:'50–100 ms',min:50,max:100},{label:'100–250 ms',min:100,max:250},{label:'250–500 ms',min:250,max:500},{label:'500+ ms',min:500,max:Infinity}];
    const latency={labels:bands.map(b=>b.label),values:bands.map(b=>summary.latencyObs.filter(o=>o.ms>=b.min&&o.ms<b.max).length)};
    const endpoints=summary.routes.slice(0,8).reverse();
    return {traffic,health:{labels:['Successful','Failed'],values:[summary.ok,summary.err]},latency,endpoints:{labels:endpoints.map(x=>x.path),values:endpoints.map(x=>x.total)}};
  }
  function insight(summary) {
    if (!$('insightTitle')) return;
    const rate=summary.total?summary.ok/summary.total*100:null;
    if(!summary.total){$('insightTitle').textContent='No signal in this window';$('insightText').textContent='No stored API requests match the selected dates and endpoint filters. Try a wider date range or clear the endpoint filter.';return;}
    if(rate<95){$('insightTitle').textContent='Reliability needs a closer look';$('insightText').textContent=`${(100-rate).toFixed(1)}% of recorded requests failed in this window. Check the endpoint leaderboard for routes contributing the most failures.`;}
    else if(summary.avg>500){$('insightTitle').textContent='Latency is running high';$('insightText').textContent=`Weighted average latency is ${Math.round(summary.avg)} ms. Compare route-level averages and peak observations to locate slower paths.`;}
    else {$('insightTitle').textContent='Telemetry looks steady';$('insightText').textContent=`${fmt(summary.total)} requests were recorded with a ${rate.toFixed(1)}% success rate. Keep an eye on the live traffic waveform for changes.`;}
  }
  function updateChartLinks() {
    const range=dateWindow();const endpoints=endpointApplied?selectedEndpoints.join(','):'';
    document.querySelectorAll('[data-chart]').forEach(a=>{const p=new URLSearchParams({type:a.dataset.chart,from:range.from,to:range.to});if(endpoints)p.set('endpoints',endpoints);a.href='/stats-chart.html?'+p.toString();});
  }
  function studioRender(summary) {
    const type=chartTypes[query.get('type')]?query.get('type'):'traffic';const meta=chartTypes[type];const data=buildChartData(summary);
    if($('studioTitle')) $('studioTitle').innerHTML=`${esc(meta.title.split(' ')[0])} <span>${esc(meta.title.split(' ').slice(1).join(' '))}</span>`;
    if($('studioDescription')) $('studioDescription').textContent=meta.desc;
    if($('chartKicker')) $('chartKicker').textContent=meta.kicker;
    if($('studioWindow')) $('studioWindow').textContent=`WINDOW  ${dateWindow().from} → ${dateWindow().to}`;
    if($('studioEndpoint')) $('studioEndpoint').textContent=endpointApplied&&selectedEndpoints.length?selectedEndpoints.join(' · '):'ALL TRACKED ENDPOINTS';
    const key='studioChart';
    if(!charts[key]) createChart(key,type,data[type]);
    else {
      const c=charts[key];const next=data[type];c.data.labels=next.labels;c.data.datasets[0].data=next.values;c.update('none');
    }
    if($('studioLegend')) $('studioLegend').innerHTML=type==='health'?`<span><i class="legend-dot green"></i> Successful: ${fmt(summary.ok)}</span><span><i class="legend-dot pink"></i> Failed: ${fmt(summary.err)}</span>`:`<span><i class="legend-dot cyan"></i> ${fmt(summary.total)} total requests in the selected window</span>`;
  }
  async function refreshData() {
    if (refreshing || !apiKey) return;
    refreshing=true;
    try {
      const raw=await fetchRows();lastRows=raw;const rows=filteredRows(raw);const summary=summarize(rows);const data=buildChartData(summary);
      if (isStudio) studioRender(summary);
      else {
        setMetric(summary);
        const config=[['trafficChart','traffic',data.traffic],['healthChart','health',data.health],['latencyChart','latency',data.latency],['endpointChart','endpoints',data.endpoints]];
        for(const [id,type,chartData] of config){if(!charts[id])createChart(id,type,chartData);else {const c=charts[id];c.data.labels=chartData.labels;c.data.datasets[0].data=chartData.values;c.update('none');}}
        tableRows(summary.routes);insight(summary);updateChartLinks();
      }
      const now=new Date();const stamp=now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      if($('lastUpdated')) $('lastUpdated').textContent=`Updated ${stamp}`;
      if($('footerState')) $('footerState').textContent='Telemetry connected · refresh every 5s';
      if($('requestFoot')) $('requestFoot').textContent=`${dateWindow().from} → ${dateWindow().to}`;
      const newStamp=`${summary.total}:${summary.ok}:${summary.err}`; if(lastDataStamp&&newStamp!==lastDataStamp&&$('liveLabel')) $('liveLabel').textContent='SIGNAL UPDATED'; else if($('liveLabel')) $('liveLabel').textContent='LIVE MONITOR';lastDataStamp=newStamp;
    } catch(e) {
      if($('footerState')) $('footerState').textContent='Telemetry unavailable';
      if(/401|403/.test(e.message)) { clearInterval(refreshTimer); showKeyGate('The API key was rejected. Enter a valid API key to continue.'); }
      else toast(e.message,'error');
    } finally {refreshing=false;}
  }
  function startRefresh() {clearInterval(refreshTimer);void refreshData();refreshTimer=setInterval(()=>void refreshData(),5000);}
  function showKeyGate(message='Enter your API key to access protected statistics.') {
    if($('keyGate')) $('keyGate').remove();
    const overlay=document.createElement('div');overlay.id='keyGate';overlay.className='key-gate';
    overlay.innerHTML=`<form class="key-card"><div class="brand-mark">Z<span>✦</span></div><div class="section-kicker">AUTHENTICATED TELEMETRY</div><h2>Unlock Stats <span>Centre</span></h2><p>${esc(message)}</p><label for="statsKey">API key / admin key</label><input id="statsKey" type="password" autocomplete="current-password" placeholder="Paste your key" required><button class="apply-btn" type="submit">Unlock analytics ↗</button><a href="/">Return to Control Room</a><small>Your key is stored in this browser tab's session storage only.</small></form>`;
    document.body.appendChild(overlay);
    overlay.querySelector('form').addEventListener('submit',e=>{e.preventDefault();apiKey=overlay.querySelector('#statsKey').value.trim();if(!apiKey)return;sessionStorage.setItem('shoob-admin-key',apiKey);overlay.remove();startRefresh();});
  }
  function applyTheme() {
    const light=localStorage.getItem('shoob-control-room-theme')==='light';document.documentElement.classList.toggle('light-theme',light);
    const b=$('themeToggle');if(b){b.textContent=light?'🌙':'☀️';b.title=light?'Switch to dark theme':'Switch to light theme';}
    if (Object.keys(charts).length) {
      // Rebuild charts with the updated axis and tooltip palette; data remains sourced from the current view.
      const summary=summarize(filteredRows(lastRows));const data=buildChartData(summary);
      if(isStudio){const type=chartTypes[query.get('type')]?query.get('type'):'traffic';createChart('studioChart',type,data[type]);}
      else {createChart('trafficChart','traffic',data.traffic);createChart('healthChart','health',data.health);createChart('latencyChart','latency',data.latency);createChart('endpointChart','endpoints',data.endpoints);}
    }
  }
  function init() {
    if(window.Chart && window.ChartZoom) Chart.register(window.ChartZoom);
    $('themeToggle')?.addEventListener('click',()=>{const light=!document.documentElement.classList.contains('light-theme');localStorage.setItem('shoob-control-room-theme',light?'light':'dark');applyTheme();});
    applyTheme();
    $('refreshNow')?.addEventListener('click',()=>void refreshData());
    $('zoomReset')?.addEventListener('click',()=>charts.studioChart?.resetZoom());
    if(!isStudio){
      const now=dateISO(today());setWindow(now,now,'today');
      document.querySelectorAll('[data-range]').forEach(b=>b.addEventListener('click',()=>applyPreset(b.dataset.range)));
      $('dateFrom')?.addEventListener('change',()=>{currentRange='custom';document.querySelectorAll('[data-range]').forEach(b=>b.classList.toggle('active',b.dataset.range==='custom'));setWindow($('dateFrom').value,$('dateTo').value,'custom');void refreshData();});
      $('dateTo')?.addEventListener('change',()=>{currentRange='custom';document.querySelectorAll('[data-range]').forEach(b=>b.classList.toggle('active',b.dataset.range==='custom'));setWindow($('dateFrom').value,$('dateTo').value,'custom');void refreshData();});
      $('endpointInput')?.addEventListener('input',validateEndpointInput);
      $('clearEndpoint')?.addEventListener('click',()=>{$('endpointInput').value='';endpointApplied=false;selectedEndpoints=[];validateEndpointInput();updateFilterSummary();void refreshData();});
      $('endpointSearch')?.addEventListener('click',()=>{if($('endpointSearch').disabled)return;selectedEndpoints=normalizeEndpointInput();endpointApplied=true;updateFilterSummary();toast(`Filtering ${selectedEndpoints.length} endpoint${selectedEndpoints.length===1?'':'s'}`);void refreshData();});
      $('resetFilters')?.addEventListener('click',()=>{$('endpointInput').value='';endpointApplied=false;selectedEndpoints=[];const now=dateISO(today());setWindow(now,now,'today');validateEndpointInput();updateFilterSummary();void refreshData();});
    } else {
      const todayStr=dateISO(today());const from=query.get('from')||todayStr;const to=query.get('to')||todayStr;setWindow(from,to,'custom');
      selectedEndpoints=(query.get('endpoints')||'').split(',').map(x=>x.trim()).filter(Boolean);endpointApplied=selectedEndpoints.length>0;
    }
    $('themeToggle')?.setAttribute('aria-label','Toggle colour theme');
    void loadDirectory().then(()=>{
      if(!apiKey){showKeyGate();return;}
      if(isStudio){
        // Drop unsupported/stale route names from shared links; the user can return to the dashboard to select routes.
        if(selectedEndpoints.some(p=>!knownEndpoints.includes(p))){selectedEndpoints=[];endpointApplied=false;toast('An endpoint in this chart link is not in the current API directory. Showing all routes.','error');}
      }
      updateFilterSummary();if(!isStudio)updateChartLinks();startRefresh();
    });
  }
  init();
})();
