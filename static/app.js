"use strict";
const $ = id => document.getElementById(id);
const state = {meta:null, result:null, config:null, frame:0, playing:false, previousTime:0, request:0};
const format = (v, digits=1) => Number.isFinite(v) ? v.toLocaleString("es-PE", {minimumFractionDigits:digits,maximumFractionDigits:digits}) : "—";
const color = {pi:"#d48a43",ff:"#118f93",sp:"#748a8b"};
const tankXs = [139, 351, 563];
let toastTimer, simcTimer, simcRequest=0;
let calibrationTimer, calibrationRequest = 0;

function toast(message){$("toast").textContent=message;$("toast").hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$("toast").hidden=true,3800);}
function showView(){
  const key = ["simulador","resultados","modelo","guia"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "simulador";
  document.querySelectorAll(".view").forEach(el=>{const active=el.id===`view-${key}`;el.hidden=!active;el.classList.toggle("active",active);});
  document.querySelectorAll(".nav-link").forEach(el=>{const active=el.dataset.view===key;el.classList.toggle("active",active);if(active)el.setAttribute("aria-current","page");else el.removeAttribute("aria-current");});
  $("current-section").textContent={simulador:"Simulador",resultados:"Resultados",modelo:"Modelo matemático",guia:"Guía de ejecución"}[key];
  if (key === "modelo") {
    updateSimc();
    updateCalibration();
    renderTrace();
  }
}
window.addEventListener("hashchange",()=>{showView();window.scrollTo({top:0,behavior:"instant"});});

function readConfig(){
  return {
    scenario:$("scenario").value,duration:Number($("duration").value),event_time:Number($("event-time").value),
    feed:Number($("feed").value),feed_step:Number($("feed-step").value),
    target:[0,1,2].map(i=>Number($("target-"+i).value)),
    kc:[0,1,2].map(i=>Number($("kc-"+i).value)),ti:[0,1,2].map(i=>Number($("ti-"+i).value)),kff:[0,1,2].map(i=>Number($("kff-"+i).value)),
    ff_mode:$("ff-mode").value,noise:Number($("noise").value),median_filter:$("median-filter").checked,
    initial:[30,34,33],seed:2023,
  };
}
function updateFields(dirty=true){
  const c=readConfig();
  [0,1,2].forEach(i=>{$("target-value-"+i).innerHTML=`${format(c.target[i])} <small>cm</small>`;$("target-"+i).disabled=!["setpoint","combined"].includes(c.scenario);});
  $("feed-step").disabled=!["disturbance","combined"].includes(c.scenario);
  $("event-time").disabled=c.scenario==="equilibrium";
  const descriptions={
    setpoint:`Las consignas cambian en t = ${c.event_time} s; la alimentación se mantiene en ${format(c.feed)} L/min.`,
    disturbance:`La alimentación cambia de ${format(c.feed)} a ${format(c.feed+c.feed_step)} L/min en t = ${c.event_time} s. Consignas constantes.`,
    combined:`Consignas en t = ${c.event_time} s. Alimentación en t = ${c.event_time+Math.floor((c.duration-c.event_time)/2)} s.`,
    equilibrium:"No se aplican cambios de consigna ni de alimentación. Útil para comprobar el equilibrio del modelo.",
  };
  $("scenario-help").textContent=descriptions[c.scenario];
  $("ff-help").textContent=c.ff_mode==="literal" ? "Usa Kff · (Q[k] − Q[k−1]). Su aporte actúa durante los cambios de caudal." : "Acumula Kff · ΔQ para sostener la compensación. Esta es una extensión didáctica del término publicado.";
  if(dirty && state.result)$("run-state").textContent="Cambios pendientes · pulsa Ejecutar simulación.";
}
async function api(url,config){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),30000);
  try{
    const response=await fetch(url,{method:config===undefined?"GET":"POST",headers:config===undefined?{}:{"Content-Type":"application/json"},body:config===undefined?undefined:JSON.stringify(config),signal:controller.signal});
    if(!response.ok){let msg="No se pudo completar el cálculo.";try{msg=(await response.json()).error||msg;}catch{}throw new Error(msg);}
    return response;
  }finally{clearTimeout(timer);}
}
async function run(){
  const invalid=$("config-form").querySelector(":invalid");
  if(invalid){const details=invalid.closest("details");if(details)details.open=true;invalid.reportValidity();return;}
  pause();const requestId=++state.request;const config=readConfig();
  $("run").disabled=true;$("run").textContent="Calculando en Python…";$("error-banner").hidden=true;$("run-state").textContent="Ejecutando las dos estrategias en el servidor…";
  const before=performance.now();
  try{
    if(!state.meta)state.meta=await(await api("/api/meta")).json();
    const result=await (await api("/api/simulate",config)).json();
    if(requestId!==state.request)return;
    state.result=result;state.config=config;state.frame=0;
    state.tankRanges = calculateTankRanges(result);
    $("engine-status").className="engine-status online";$("engine-status").innerHTML="<i></i> Motor Python conectado";
    renderResults();renderPlant();drawFrame();
    resetTrace();
    $("run-state").textContent=JSON.stringify(config)===JSON.stringify(readConfig()) ? `Ensayo calculado · ${result.feedback.data.t.length} muestras · ${format((performance.now()-before)/1000,2)} s de cálculo y transferencia.` : "Ensayo calculado. Hay cambios pendientes por ejecutar.";
  }catch(error){
    $("error-banner").hidden=false;$("error-banner").textContent=error.name==="AbortError"?"El servidor tardó demasiado. Intenta ejecutar otra vez.":error.message;
    $("run-state").textContent="El ensayo no se pudo calcular. Revisa el mensaje.";
    if(error instanceof TypeError){$("engine-status").className="engine-status offline";$("engine-status").innerHTML="<i></i> Sin conexión con Python";}
  }finally{$("run").disabled=false;$("run").innerHTML="<span>▶</span> Ejecutar simulación";}
}

function makeChart(container,cell,key,title,unit,withSetpoint=false){
  const r=state.result;const a=r.feedback.data,b=r.feedforward.data;
  const series=[{values:a[key].map(row=>row[cell]),color:color.pi,label:"PI"},{values:b[key].map(row=>row[cell]),color:color.ff,label:"PI + FF"}];
  if(withSetpoint)series.push({values:a.setpoint.map(row=>row[cell]),color:color.sp,label:"Consigna",dash:true});
  let min=Infinity,max=-Infinity;
  series.forEach(s=>s.values.forEach(v=>{min=Math.min(min,v);max=Math.max(max,v);}));
  let pad=Math.max((max-min)*.16,withSetpoint?.15:2);
  min-=pad;max+=pad;if(!withSetpoint)min=Math.max(0,min);
  const left=44,right=309,top=18,bottom=169,width=320,height=201,N=a.t.length-1;
  const X=k=>left+(right-left)*k/N,Y=v=>bottom-(v-min)/(max-min)*(bottom-top);
  let markup=`<div class="chart-card-head"><h3>${title} ${String(cell+1).padStart(2,"0")}</h3><span>${unit}</span></div><div class="chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${title} ${cell+1}, comparación PI y PI más feedforward"><title>${title} ${cell+1}: PI, PI más feedforward${withSetpoint?" y consigna":""}</title>`;
  for(let j=0;j<=3;j++){const value=min+(max-min)*j/3,y=Y(value);markup+=`<path class="grid" d="M${left} ${y}H${right}"/><text x="${left-8}" y="${y+3}" text-anchor="end">${format(value,withSetpoint?1:0)}</text>`;}
  [0,Math.round(N/2),N].forEach(k=>{markup+=`<text x="${X(k)}" y="187" text-anchor="middle">${k}</text>`;});
  r.events.forEach(event=>{markup+=`<path class="event-line" d="M${X(event.t)} ${top}V${bottom}"><title>${event.label} · ${event.t} s</title></path>`;});
  series.forEach(s=>{const path=s.values.map((v,k)=>`${k===0?"M":"L"}${X(k).toFixed(2)},${Y(v).toFixed(2)}`).join(" ");markup+=`<path class="line" stroke="${s.color}" ${s.dash?'stroke-dasharray="5 4" stroke-width="1.3"':''} d="${path}"/>`;});
  markup+=`<path class="chart-cursor" d="M${left} ${top}V${bottom}"/><text x="${right}" y="200" text-anchor="end">tiempo (s)</text><rect class="chart-hit" x="${left}" y="${top}" width="${right-left}" height="${bottom-top}" fill="transparent"/></svg><div class="chart-tooltip" hidden></div></div><div class="chart-foot">Escala vertical automática · pasa el cursor para inspeccionar</div>`;
  const card=document.createElement("article");card.className="chart-card";card.innerHTML=markup;container.appendChild(card);
  const svg=card.querySelector("svg"),tip=card.querySelector(".chart-tooltip");
  card.querySelector(".chart-hit").addEventListener("pointermove",event=>{const bounds=svg.getBoundingClientRect();const x=(event.clientX-bounds.left)/bounds.width*width;const k=Math.max(0,Math.min(N,Math.round((x-left)/(right-left)*N)));tip.innerHTML=`<strong>t = ${k} s</strong><br>`+series.map(s=>`${s.label}: ${format(s.values[k],2)} ${unit}`).join("<br>");tip.hidden=false;});
  card.querySelector(".chart-hit").addEventListener("pointerleave",()=>tip.hidden=true);
}
function renderResults(){
  const r=state.result,c=r.config,summary=r.summary;
  $("stat-pi").textContent=format(summary.iae_feedback,1);$("stat-ff").textContent=format(summary.iae_feedforward,1);
  $("stat-change").textContent=format(summary.improvement_pct,1);
  $("change-caption").textContent=summary.improvement_pct===null?"Sin error acumulado para comparar":summary.improvement_pct < -.05?"Valor negativo: el IAE aumentó":summary.improvement_pct>.05?"Menor error en este ensayo":"Desempeño equivalente en IAE";
  $("timeline").max=c.duration;$("timeline").value=0;
  const event = r.events[0];
  $("jump-event").hidden = !event;
  if (event) $("jump-event").textContent = `Ir al primer evento · ${event.t} s`;
  $("simulation-warnings").hidden=!r.warnings.length;$("simulation-warnings").textContent=r.warnings.join(" ");
  $("result-context").textContent=`${state.meta.scenarios[c.scenario]} · ${c.duration} s · feedforward ${c.ff_mode==="literal"?"literal (ecs. 7–8)":"sostenido (extensión)"} · ruido σ = ${format(c.noise,2)} cm · filtro ${c.median_filter?"activado":"desactivado"}. Resultados del último ensayo ejecutado.`;
  let table="";
  for(let i=0;i<3;i++)for(const [key,label,klass] of [["feedback","PI","amber"],["feedforward","PI + FF","teal"]]){const m=r[key].metrics[i];table+=`<tr><td><span class="cell-tag">CELDA ${i+1}</span><i class="key ${klass}"></i>${label}</td><td>${format(m.iae,2)}</td><td>${format(m.ise,2)}</td><td>${format(m.max_error,3)}</td><td>${format(m.final_error,3)}</td><td>${format(m.saturation_pct,1)}</td><td>${format(m.total_variation,1)}</td></tr>`;}
  $("metrics-body").innerHTML=table;
  for(const [id,key,title,unit,sp] of [["level-charts","level","Celda","cm",true],["command-charts","command","Bomba P-","L/min",false],["inlet-charts","inlet","Entrada C-","L/min",false]]){$(id).innerHTML="";for(let i=0;i<3;i++)makeChart($(id),i,key,title,unit,sp);}
  const change=summary.improvement_pct;
  $("interpretation-title").textContent=change===null?"Equilibrio sin error acumulado":change<-.05?"La anticipación aumentó el error en este ensayo":change>.05?"La anticipación redujo el error en este ensayo":"Las estrategias obtuvieron un IAE equivalente";
  let description=`El IAE total pasó de ${format(summary.iae_feedback,2)} a ${format(summary.iae_feedforward,2)} cm·s. `;
  if(c.scenario==="setpoint"||c.scenario==="equilibrium")description+="La celda 1 recibe un caudal constante, por lo que su término feedforward es cero. En las otras celdas, los cambios de salida aguas arriba se convierten en perturbaciones. ";
  if(c.ff_mode==="literal")description+="El modo literal utiliza solo el cambio de caudal entre muestras; su efecto puede ser pequeño y depende del ensayo.";
  else description+="La extensión sostenida mantiene la compensación cuando la perturbación deja de cambiar. Sus resultados no representan el código original del artículo.";
  if(r.warnings.length)description+=" Atención: consulta las advertencias del simulador antes de interpretar el ensayo.";
  $("interpretation-text").textContent=description;
}

function calculateTankRanges(result) {
  return tankXs.map((_, cell) => {
    const levels = [result.feedback.data, result.feedforward.data].flatMap(data =>
      [...data.level, ...data.setpoint].map(values => values[cell]));
    const min = Math.min(...levels);
    const max = Math.max(...levels);
    const padding = Math.max(0.1, (max - min) * 0.15, (1 - (max - min)) / 2);
    return [Math.floor((min - padding) * 10) / 10, Math.ceil((max + padding) * 10) / 10];
  });
}

function showTankScale() {
  const zoom = $("plant-scale").value === "zoom";
  $("plant-scale-note").textContent = zoom
    ? "Nivel ampliado para ver cambios pequeños. Cada celda indica su escala en cm. Δ es el cambio desde el inicio."
    : "La altura de los tanques representa de 0 a 45 cm. Δ es el cambio desde el inicio.";
  tankXs.forEach((_, i) => {
    const [low, high] = zoom ? state.tankRanges[i] : [0, 45];
    $("tank-range-" + i).textContent = `${format(low)}–${format(high)} cm`;
  });
}

function renderPlant(){
  let svg=`<svg viewBox="0 0 800 315" xmlns="http://www.w3.org/2000/svg"><defs>
  <linearGradient id="steel" x1="0" x2="1"><stop stop-color="#b8c5c9"/><stop offset=".18" stop-color="#f1f5f5"/><stop offset=".75" stop-color="#c8d3d6"/><stop offset="1" stop-color="#94a7ae"/></linearGradient>
  <linearGradient id="side-steel" x1="0" x2="1"><stop stop-color="#a6b9c0"/><stop offset="1" stop-color="#dae3e5"/></linearGradient>
  <linearGradient id="water" x1="0" x2="1" y1="1" y2="0"><stop stop-color="#168de0"/><stop offset="1" stop-color="#43bff0"/></linearGradient>
  <linearGradient id="pump" x1="0" x2="1"><stop stop-color="#087697"/><stop offset=".5" stop-color="#23a4b7"/><stop offset="1" stop-color="#12586c"/></linearGradient>
  <pattern id="plant-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#e7edef" stroke-width=".5"/></pattern>
  <marker id="flow-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 0L5 2.5L0 5" fill="none" stroke="#53aabb" stroke-width="1"/></marker></defs>
  <rect x="7" y="34" width="786" height="255" rx="9" fill="url(#plant-grid)"/><path d="M20 266H782" stroke="#cdd8da"/>
  <text x="27" y="54" fill="#779199" font-size="8" letter-spacing="1.2">ALIMENTACIÓN</text><text id="feed-label" x="27" y="70" font-family="Consolas,monospace" font-size="12" fill="#3387a0">45.0 L/min</text>
  <path d="M65 202V113Q65 104 74 104H139" stroke="#aabdc4" stroke-width="9" fill="none"/><path d="M65 202V113Q65 104 74 104H137" stroke="#f7fafb" stroke-width="4" fill="none"/><path class="flow-path" d="M65 195V113Q65 104 74 104H132" stroke="#35a9c2" stroke-width="2" fill="none" marker-end="url(#flow-arrow)"/>
  <rect x="22" y="203" width="81" height="51" rx="4" fill="url(#steel)" stroke="#a0b4ba"/><rect x="29" y="220" width="67" height="27" rx="2" fill="#53b4db" opacity=".65"/><text x="63" y="215" text-anchor="middle" fill="#5b7885" font-size="8">T-1 · 130 L</text><text x="63" y="242" text-anchor="middle" fill="white" font-size="7">RESERVORIO</text>
  <g transform="translate(65 152)"><circle r="12" fill="url(#pump)" stroke="#17647b"/><path class="pump-blade" d="M-7 0H7M0-7V7" stroke="#c4f0f6" stroke-width="2"/><text x="-25" y="27" font-size="8" fill="#6f8690">P-4</text></g>
  <path d="M762 210V278H63V254" stroke="#b9c9ce" stroke-width="4" fill="none"/><path d="M762 210V278H63V254" stroke="#5cabbf" stroke-width="1.4" class="flow-path" fill="none"/><text x="400" y="300" font-size="8" fill="#8b9fa3" text-anchor="middle">RETORNO A T-1 · depósito no dinámico en este modelo</text>`;
  tankXs.forEach((x,i)=>{
    const w=124,base=247,top=82;
    const pipeEnd=i<2?tankXs[i+1]:762;
    svg+=`<g id="cell-${i}"><rect x="${x+18}" y="29" width="80" height="22" rx="5" fill="#e6eff0" stroke="#cfdddf"/><circle id="cell-light-${i}" cx="${x+31}" cy="40" r="3" fill="#58a88b"/><text x="${x+67}" y="43" font-size="9" letter-spacing="1" fill="#5f7c84" text-anchor="middle">CELDA 0${i+1}</text>
    <path d="M${x+w} ${top}l15-9v165l-15 9Z" fill="url(#side-steel)" stroke="#9cb1b8"/><path d="M${x} ${top}l15-9h124l-15 9Z" fill="#eef3f4" stroke="#a8bcc1"/>
    <rect x="${x}" y="${top}" width="${w}" height="${base-top}" rx="3" fill="url(#steel)" stroke="#9bb0b8"/>
    <rect x="${x+19}" y="${top+8}" width="84" height="146" rx="2" fill="#eaf4f8" stroke="#afc9d0"/>
    <rect id="water-${i}" x="${x+20}" y="130" width="82" height="105" fill="url(#water)"/>
    <path id="surface-${i}" d="M${x+20} 130h82" stroke="#9de7fb" stroke-width="3"/>
    <clipPath id="water-clip-${i}"><use href="#water-${i}"/></clipPath>
    <g fill="#d2f4ff" opacity=".6" clip-path="url(#water-clip-${i})">${[0,1,2,3,4,5,6].map((j)=>`<circle class="bubble" cx="${x+28+(j*29)%62}" cy="${208+(j*7)%22}" r="${1.2+(j%3)*.5}"/>`).join("")}</g>
    <rect x="${x+20}" y="${top+9}" width="10" height="144" fill="white" opacity=".16"/>
    <path id="sp-${i}" d="M${x+14} 128h95" stroke="#566c82" stroke-dasharray="4 3" stroke-width="1.3"/>
    <text id="sp-label-${i}" x="${x+19}" y="121" font-size="7" fill="#576c82">SP 30.0</text>
    <g stroke="#f3c748" stroke-width="3"><path d="M${x+111} 93V247M${x+123} 89V242"/>${[101,117,133,149,165,181,197,213,229,241].map(y=>`<path d="M${x+111} ${y}l12-4" stroke-width="2"/>`).join("")}</g>
    <path d="M${x+62} 82V64" stroke="#95acb3" stroke-width="4"/><rect x="${x+43}" y="52" width="38" height="24" rx="3" fill="#339db8" stroke="#2d7991"/><rect x="${x+47}" y="56" width="30" height="12" rx="1" fill="#d7f0b1"/><text id="sensor-${i}" x="${x+62}" y="65" font-size="9" text-anchor="middle" font-family="Consolas,monospace" fill="#3a724d">30.0</text><text x="${x+88}" y="64" font-size="7" fill="#6e8993">LI-${i+1}</text>
    <path d="M${x+10} 247V260M${x+112} 247V260" stroke="#98aeb4" stroke-width="5"/>
    <g stroke="#8ca5ae" stroke-width=".8">${[0,1,2,3,4].map(j=>`<path d="M${x+7} ${235-j*32}h${j%2?4:7}"/>`).join("")}</g>
    <path d="M${x+w+15} 212H${pipeEnd-10}Q${pipeEnd} 212 ${pipeEnd} 202V175" fill="none" stroke="#b8c6cc" stroke-width="8"/><path d="M${x+w+15} 212H${pipeEnd-10}Q${pipeEnd} 212 ${pipeEnd} 202V175" fill="none" stroke="#f7fafb" stroke-width="3"/>
    <path class="flow-path" d="M${x+w+16} 212H${pipeEnd-10}Q${pipeEnd} 212 ${pipeEnd} 202V178" stroke="#41a5ba" stroke-width="1.4" fill="none"/>
    <g transform="translate(${x+w+42} 212)"><path d="M-18 14H20" stroke="#7e969b" stroke-width="4"/><rect x="-8" y="-10" width="25" height="22" rx="3" fill="url(#pump)" stroke="#196d7e"/><path d="M-1-8V10M4-8V10M9-8V10" stroke="#4db4c3"/><circle r="10" cx="-10" fill="#188ba4" stroke="#176b7e"/><g transform="translate(-10 0)"><path class="pump-blade" d="M-5 0H5M0-5V5" stroke="#bfe9f0" stroke-width="1.5"/></g><circle id="pump-light-${i}" cx="15" cy="-17" r="3.5" fill="#42c778" stroke="#299657"/><text x="0" y="35" text-anchor="middle" font-size="8" fill="#4f7a88">P-${i+1}</text><text id="pump-flow-${i}" x="0" y="-29" text-anchor="middle" font-size="9" fill="#318aaa" font-family="Consolas,monospace">45.0</text></g></g>`;
  });
  svg+="</svg>";$("plant").innerHTML=svg;
  $("cell-readings").innerHTML=tankXs.map((_, i)=>`<div class="cell-reading"><span>C-0${i+1}<br><small id="tank-range-${i}">—</small></span><div><strong id="level-${i}">—</strong> <small>cm</small><br><small id="level-delta-${i}">Δ 0.00 cm</small></div></div>`).join("");
  if (state.result) showTankScale();
}
function drawFrame(){
  if(!state.result)return;
  const k=Math.min(state.config.duration,Math.floor(state.frame));const strategy=$("plant-strategy").value;const d=state.result[strategy].data;
  $("timeline").value=k;$("play-time").textContent=`${String(k).padStart(3,"0")} / ${state.config.duration} s`;
  $("feed-label").textContent=`${format(d.inlet[k][0])} L/min`;
  const zoom = $("plant-scale").value === "zoom";
  tankXs.forEach((x, i)=>{
    const level = d.level[k][i];
    const sp = d.setpoint[k][i];
    const [low, high] = zoom ? state.tankRanges[i] : [0, 45];
    const heightToY = value => 235 - 145 * (Math.min(high, Math.max(low, value)) - low) / (high - low);
    const y = heightToY(level);
    const spY = heightToY(sp);
    $("water-"+i).setAttribute("y",y);$("water-"+i).setAttribute("height",235-y);$("surface-"+i).setAttribute("d",`M${x+20} ${y}h82`);
    $("sp-"+i).setAttribute("d",`M${x+14} ${spY}h95`);$("sp-label-"+i).setAttribute("y",Math.max(99,spY-5));$("sp-label-"+i).textContent=`SP ${format(sp)}`;
    const delta = level - d.level[0][i];
    const sign = Math.abs(delta) < 0.005 ? "" : delta > 0 ? "+" : "−";
    $("level-delta-" + i).textContent = `Δ ${sign}${format(Math.abs(delta), 2)} cm`;
    $("level-"+i).textContent=format(level,2);$("sensor-"+i).textContent=format(d.measured[k][i]);$("pump-flow-"+i).textContent=`${format(d.outlet[k][i])} L/min`;
    const saturated=d.command[k][i]<1e-8||d.command[k][i]>state.meta.pump_max[i]-1e-8;
    $("pump-light-"+i).setAttribute("fill",saturated?"#ec9c32":d.outlet[k][i]>.01?"#50c67b":"#abb6b7");
    $("cell-light-"+i).setAttribute("fill",level<0||level>45?"#cf564b":"#58a88b");
  });
  document.querySelectorAll(".chart-cursor").forEach(el=>el.setAttribute("d",`M${44+265*k/state.config.duration} 18V169`));
  drawSignals(d,k);
}
function drawSignals(d,k){
  const i=Number($("signal-cell").value),c=state.result.config;
  const saturation=d.command[k][i]<=1e-8||d.command[k][i]>=state.meta.pump_max[i]-1e-8;
  $("signal-chain").innerHTML=`<div><span>LI-${i+1} · MEDICIÓN</span><strong>${format(d.measured[k][i],2)} <small>cm</small></strong><em>SP ${format(d.setpoint[k][i],2)} cm</em></div><b>→</b><div><span>PI · ERROR</span><strong>${format(d.error[k][i],3)} <small>cm</small></strong><em>Kc ${c.kc[i]} · τi ${c.ti[i]} s</em></div><b>→</b><div><span>P-${i+1} · MANDO</span><strong>${format(d.command[k][i],2)} <small>L/min</small></strong><em>${format(d.bits[k][i],0)} cuentas · ${saturation?"SATURADO":"en rango"}</em></div>`;
  $("signal-contributions").innerHTML=`<span>Sesgo <b>${format(c.feed,1)}</b></span><span>Proporcional <b>${format(d.proportional[k][i],2)}</b></span><span>Integral <b>${format(d.integral[k][i],2)}</b></span><span>Feedforward <b>${format(d.ff[k][i],2)}</b></span><span class="signal-limit">Σ → límite [0, ${format(state.meta.pump_max[i])}] L/min</span>`;
}

function selectTraceTime(time) {
  const duration = state.result.config.duration;
  const second = Math.min(duration, Math.max(0, Math.round(time)));
  $("trace-time").value = second;
  $("trace-slider").value = second;
  renderTrace();
}

function resetTrace() {
  const duration = state.result.config.duration;
  $("trace-time").max = duration;
  $("trace-slider").max = duration;
  $("trace-show-plant").disabled = false;
  $("trace-steps").hidden = false;
  $("inspect-frame").hidden = false;
  selectTraceTime(state.result.events[0]?.t ?? 0);
}

function renderTrace() {
  if (!state.result) return;
  const t = Number($("trace-slider").value);
  const cell = Number($("trace-cell").value);
  const strategy = $("trace-strategy").value;
  const {config, dt} = state.result;
  const d = state.result[strategy].data;
  const value = key => d[key][t][cell];
  const f = (key, digits = 3) => format(value(key), digits);
  const delay = state.meta.delays[cell];
  const inletSource = cell === 0 ? "la alimentación del banco" : `la salida de C-${cell}`;
  $("trace-context").textContent = `${state.meta.scenarios[config.scenario]} · C-${cell + 1} · t = ${t} s · Δt = ${dt} s`;
  $("trace-flows").textContent = `Qentrada = ${f("inlet")} L/min de ${inletSource}. Qsalida = ${f("outlet")} L/min.`;
  $("trace-delay").textContent = t < delay
    ? `Qsalida usa el caudal previo al ensayo mientras transcurre el retardo de ${delay} s.`
    : `Qsalida[t] = mando[t − ${delay} s]. El caudal mostrado viene de la orden en t = ${t - delay} s.`;
  $("trace-error").textContent = `e = SP − nivel medido = ${f("setpoint")} − ${f("measured")} = ${f("error")} cm.`;
  const integralNote = value("integral_held") ? " La protección contra saturación retuvo la integral." : "";
  $("trace-pi").textContent = `P = ${format(config.kc[cell], 2)} × (${f("error")}) = ${f("proportional")} L/min. I = ${f("integral")} L/min (τi = ${format(config.ti[cell], 1)} s).${integralNote}`;
  const ffMode = config.ff_mode === "literal" ? "FF = Kff × ΔQ" : "FF = FF anterior + Kff × ΔQ";
  $("trace-ff").textContent = strategy === "feedback"
    ? `ΔQ = ${f("inlet_change")} L/min. En solo PI, FF = 0 L/min.`
    : `ΔQ = ${f("inlet_change")} L/min. ${ffMode} = ${f("ff")} L/min con Kff = ${format(config.kff[cell], 2)}.`;
  $("trace-command").textContent = `Sesgo + P + I + FF = ${format(config.feed, 3)} + (${f("proportional")}) + (${f("integral")}) + (${f("ff")}) = ${f("raw_command")} L/min.`;
  $("trace-limit").textContent = `Con límite de 0 a ${format(state.meta.pump_max[cell])} L/min, el mando queda en ${f("command")} L/min (${f("bits", 1)} cuentas equivalentes).`;
  $("trace-rate").textContent = `dh/dt = ${format(Math.abs(state.meta.gain), 6)} × (${f("inlet")} − ${f("outlet")}) = ${f("level_rate", 6)} cm/s.`;
  $("trace-next").textContent = t < config.duration
    ? `h[${t + 1}] = ${f("level", 6)} + (${f("level_rate", 6)} × ${dt}) = ${format(d.level[t + 1][cell], 6)} cm.`
    : `Última muestra: h[${t}] = ${f("level", 6)} cm. El ensayo termina en este instante.`;
}

async function updateCalibration() {
  const id = ++calibrationRequest;
  const pump = $("calibration-pump").value;
  const counts = $("calibration-counts").value;
  try {
    const r = await (await api(`/api/calibration?${new URLSearchParams({pump, counts})}`)).json();
    if (id !== calibrationRequest) return;
    $("calibration-value").textContent = `${r.pump}: ${format(r.slope, 4)} L/min por cuenta × ${format(r.counts, 0)} cuentas = ${format(r.flow, 3)} L/min.`;
    const plotY = flow => 120 - flow * 1.05;
    $("calibration-line").setAttribute("d", `M53 120L408 ${plotY(r.max_flow)}`);
    $("calibration-dot").setAttribute("cx", 53 + 355 * r.counts / r.max_counts);
    $("calibration-dot").setAttribute("cy", plotY(r.flow));
    $("calibration-chart").hidden = false;
  } catch (error) {
    if (id !== calibrationRequest) return;
    $("calibration-value").textContent = error.message;
    $("calibration-chart").hidden = true;
  }
}

function pause(){state.playing=false;$("plant").classList.remove("is-playing");$("hmi-status-text").textContent="● Reproducción en pausa";$("play").classList.remove("selected");$("pause").classList.add("selected");}
function play(){if(!state.result)return;if(state.frame>=state.config.duration)state.frame=0;state.playing=true;state.previousTime=performance.now();$("plant").classList.add("is-playing");$("hmi-status-text").textContent="● Reproduciendo ensayo calculado";$("play").classList.add("selected");$("pause").classList.remove("selected");requestAnimationFrame(tick);}
function tick(now){if(!state.playing)return;state.frame=Math.min(state.config.duration,state.frame+(now-state.previousTime)/1000*Number($("speed").value));state.previousTime=now;drawFrame();if(state.frame>=state.config.duration){pause();$("hmi-status-text").textContent="● Ensayo finalizado";}else requestAnimationFrame(tick);}

async function updateSimc(){
  const id=++simcRequest;const tau=Number($("simc-tau").value),cell=$("simc-cell").value;
  try{const r=await(await api(`/api/simc?cell=${encodeURIComponent(cell)}&tau_c=${encodeURIComponent(tau)}`)).json();if(id!==simcRequest)return;$("simc-result").innerHTML=`Kc = ${format(r.kc,2)}<br>τi = ${format(r.ti,1)} s<small>${r.robust?"τc ≥ θ · criterio de robustez satisfecho":"τc < θ · elección más agresiva que el criterio indicado"}</small>`;}catch(error){if(id===simcRequest)$("simc-result").textContent=error.message;}
}
async function download(kind,button){
  if(!state.result){toast("Primero ejecuta un ensayo.");return;}button.disabled=true;
  try{const response=await api(`/api/export/${kind}`,state.config);const blob=await response.blob();const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`flotationlab_${state.config.scenario}.${kind}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);toast("Resultados del último ensayo exportados.");}catch(error){toast(error.message);}finally{button.disabled=false;}
}

$("config-form").noValidate=true;
$("config-form").addEventListener("submit",event=>{event.preventDefault();run();});
$("config-form").addEventListener("input",()=>updateFields());
$("reset").addEventListener("click",()=>{$("config-form").reset();updateFields();toast("Parámetros restablecidos. Ejecuta para actualizar los resultados.");});
$("play").addEventListener("click",()=>{if(!state.playing)play();});$("pause").addEventListener("click",pause);
$("timeline").addEventListener("input",()=>{pause();state.frame=Number($("timeline").value);drawFrame();});
$("jump-event").addEventListener("click", () => {
  const event = state.result?.events[0];
  if (!event) return;
  pause();
  state.frame = event.t;
  drawFrame();
});
$("plant-strategy").addEventListener("change",drawFrame);$("signal-cell").addEventListener("change",drawFrame);
$("plant-scale").addEventListener("change", () => {
  if (!state.result) return;
  showTankScale();
  drawFrame();
});
$("simc-cell").addEventListener("change",()=>{$("simc-tau").value=[7,6,3][Number($("simc-cell").value)];updateSimc();});
$("simc-tau").addEventListener("input",()=>{clearTimeout(simcTimer);simcTimer=setTimeout(updateSimc,300);});
$("trace-cell").addEventListener("change", renderTrace);
$("trace-strategy").addEventListener("change", renderTrace);
$("trace-slider").addEventListener("input", event => selectTraceTime(Number(event.target.value)));
$("trace-time").addEventListener("change", event => selectTraceTime(Number(event.target.value)));
$("inspect-frame").addEventListener("click", () => {
  $("trace-cell").value = $("signal-cell").value;
  $("trace-strategy").value = $("plant-strategy").value;
  selectTraceTime(Math.floor(state.frame));
});
$("trace-show-plant").addEventListener("click", () => {
  pause();
  $("signal-cell").value = $("trace-cell").value;
  $("plant-strategy").value = $("trace-strategy").value;
  state.frame = Number($("trace-slider").value);
  drawFrame();
  location.hash = "simulador";
});
$("calibration-pump").addEventListener("change", () => {
  clearTimeout(calibrationTimer);
  updateCalibration();
});
$("calibration-counts").addEventListener("input", () => {
  clearTimeout(calibrationTimer);
  calibrationRequest++;
  calibrationTimer = setTimeout(updateCalibration, 120);
});
document.querySelectorAll("[data-export]").forEach(button=>button.addEventListener("click",()=>download(button.dataset.export,button)));
$("source-details").addEventListener("toggle",async()=>{if($("source-details").open&&!$("model-source").dataset.loaded){try{$("model-source").textContent=await(await api("/api/model-source")).text();$("model-source").dataset.loaded="true";}catch(error){$("model-source").textContent=error.message;}}});
document.addEventListener("visibilitychange",()=>{if(document.hidden)pause();});

(async function init(){
  showView();updateFields(false);renderPlant();
  try{state.meta=await(await api("/api/meta")).json();await run();}
  catch(error){$("engine-status").className="engine-status offline";$("engine-status").innerHTML="<i></i> Sin conexión con Python";$("error-banner").hidden=false;$("error-banner").textContent="No se puede conectar con Python. Inicia app.py y abre la dirección que muestre el servidor.";$("run-state").textContent="Servidor no disponible.";}
})();
