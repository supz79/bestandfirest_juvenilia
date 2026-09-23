/* Best&Fairest Beta.7.20.4 - A-26 Fix visualizzazione partita dal Calendario */

let players = [];
let matches = [];
let currentMatch = null;
let lineup = [];
let localVoted = false;
let localVoteRanking = [];
let localVoteMatchId = null;
let calendarDraft = [];
let currentMatchStats = {};
let currentMatchSummary = {};
let statsRenderToken = 0;
let matchStatsDraftDirty = false;
let matchStatsExceptionOpen = false;
let matchDetailsPromise = null;
let matchDetailsFor = null;
let voteProgressTimer = null;

// A-04: resetta la cache temporanea del tabellino quando cambia la sessione.
// Evita che, dopo logout/login, il caricamento da Firestore venga saltato
// perché la stessa partita risulta già marcata come caricata.
function resetMatchViewCache(){
  currentMatchStats = {};
  currentMatchSummary = {};
  matchStatsDraftDirty = false;
  matchStatsExceptionOpen = false;
  matchDetailsPromise = null;
  matchDetailsFor = null;
  currentMatch = null;
  lineup = [];
  localVoted = false;
  localVoteRanking = [];
  localVoteMatchId = null;
  if(voteTimer){ clearInterval(voteTimer); voteTimer=null; }
  if(voteProgressTimer){ clearInterval(voteProgressTimer); voteProgressTimer=null; }
  renderMatch._loadedStatsFor = null;
}
window.resetMatchViewCache = resetMatchViewCache;

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

function isSuperAdmin(){ return window.currentUserData?.role === 'superAdmin'; }
function isAdmin(){ return window.currentUserData?.role === 'admin' || window.currentUserData?.role === 'superAdmin'; }
function isPlayer(){ return window.currentUserData?.role === 'player'; }
function uid(){ return firebase.auth().currentUser?.uid || ''; }
function leagueId(){ return window.currentUserData?.leagueId || 'demo'; }
const DEFAULT_PLAYER_VISIBILITY={match:true,played:true,players:true,storicoSquadra:true};
function playerVisibility(){ return Object.assign({},DEFAULT_PLAYER_VISIBILITY,window.currentLeagueData?.playerVisibility||{}); }
function playerCanSeeScreen(screen){
  if(!isPlayer()) return true;
  const v=playerVisibility();
  if(screen==='match') return v.match!==false;
  if(screen==='played') return v.played!==false;
  if(screen==='players') return v.players!==false;
  if(screen==='storicoSquadra') return v.storicoSquadra!==false;
  return true;
}
function applyPlayerVisibility(){
  // La visibilità è una preferenza che vale solo per i Player.
  // Dopo un logout/login la stessa pagina resta in memoria: se un Player
  // aveva nascosto una sezione, l'Admin successivo non deve ereditarne
  // la classe CSS `hidden`.
  const v=playerVisibility();
  const map={match:v.match!==false,played:v.played!==false,players:v.players!==false,storicoSquadra:v.storicoSquadra!==false};
  const effectiveMap=isPlayer()?map:{match:true,played:true,players:true,storicoSquadra:true};
  Object.entries(effectiveMap).forEach(([screen,visible])=>{
    document.querySelectorAll(`[data-screen="${screen}"]`).forEach(el=>el.classList.toggle('hidden',!visible));
  });
  // Classifiche Squadra è una schermata vera e propria, non solo un pulsante.
  // Per Admin/SuperAdmin deve essere sempre visibile; per Player segue la
  // preferenza salvata dall'Admin.
  const storicoScreen=document.getElementById('storicoSquadra');
  if(storicoScreen) storicoScreen.classList.toggle('hidden',!effectiveMap.storicoSquadra);
  if(isPlayer() && !effectiveMap.storicoSquadra && storicoScreen?.classList.contains('active')){
    show('dashboard',true);
  }
}
async function renderPlayerVisibilityForm(){
  const form=$('#playerVisibilityForm');
  if(!form||!isAdmin()) return;
  const v=playerVisibility();
  $('#visMatch').checked=v.match!==false;
  $('#visPlayed').checked=v.played!==false;
  $('#visPlayers').checked=v.players!==false;
  $('#visStoricoSquadra').checked=v.storicoSquadra!==false;
}
async function savePlayerVisibility(e){
  e.preventDefault(); if(!isAdmin()) return;
  const data={
    match:$('#visMatch').checked,
    played:$('#visPlayed').checked,
    players:$('#visPlayers').checked,
    storicoSquadra:$('#visStoricoSquadra').checked
  };
  const msg=$('#playerVisibilityMsg');
  try{
    await db.collection('leagues').doc(leagueId()).update({playerVisibility:data,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    window.currentLeagueData=Object.assign({},window.currentLeagueData,{playerVisibility:data});
    applyPlayerVisibility();
    if(msg) msg.textContent='✅ Visibilità Player salvata.';
  }catch(err){
    console.error('Visibilità Player:',err);
    if(msg) msg.textContent='❌ Impossibile salvare la visibilità.';
  }
}

function leagueTeam(){ return window.currentLeagueData?.teamName || 'Squadra'; }
function localTeam(){ return leagueTeam(); }

function escapeHtml(value='') {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function playerName(p){ return p.displayName || [p.nome,p.cognome].filter(Boolean).join(' ') || 'Giocatore'; }
function normalizeName(v='') { return String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
function isLocalTeamName(name='') {
  const a = normalizeName(name), b = normalizeName(leagueTeam());
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  // Il calendario può usare una denominazione sportiva abbreviata rispetto alla lega.
  const aliases = ['juvenilia','polisportiva juvenilia'];
  return aliases.some(x => a.includes(x)) && b.includes('juvenilia');
}
function canonicalPair(a,b){ return [normalizeName(a),normalizeName(b)].sort().join('|'); }
function calendarKey(row){ return `${normalizeName(row.fase || 'andata')}|${String(row.giornata)}|${canonicalPair(row.casa,row.trasferta)}`; }

function parseDateTime(match){
  if (match?.scheduledStart?.toDate) return match.scheduledStart.toDate();
  if (match?.scheduledStart instanceof Date) return match.scheduledStart;
  if (match?.date && match?.time) {
    const parts = String(match.date).split('/');
    if (parts.length === 3) {
      const iso = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}T${String(match.time).padStart(5,'0')}:00+02:00`;
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}
function matchHasStarted(m=currentMatch){ const d = parseDateTime(m); return !!d && Date.now() >= d.getTime(); }
function matchEndDate(m=currentMatch){
  if(!m) return null;
  if(m.finishedAt?.toDate) return m.finishedAt.toDate();
  if(m.finishedAt instanceof Date) return m.finishedAt;
  if(m.finishedAt) { const d=new Date(m.finishedAt); if(!Number.isNaN(d.getTime())) return d; }
  return parseDateTime(m);
}
function votingDeadlineDate(m=currentMatch){ const end=matchEndDate(m); return end ? new Date(end.getTime()+6*60*60*1000) : null; }
function votingWindowOpen(m=currentMatch){
  if(!m || String(m.status||'')!=='finished') return false;
  if(m.votingClosed===true) return false;
  if(!m.finishedAt) return false;
  const deadline=votingDeadlineDate(m);
  return !!deadline && Date.now() <= deadline.getTime();
}
function votingRemainingMs(m=currentMatch){ const d=votingDeadlineDate(m); return d ? Math.max(0,d.getTime()-Date.now()) : 0; }
function formatCountdown(ms){ const total=Math.floor(Math.max(0,ms)/1000); const days=Math.floor(total/86400); const h=Math.floor(total%86400/3600); const min=Math.floor(total%3600/60); const sec=total%60; return `${days}g ${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
function formatNextMatchCountdown(ms){ const total=Math.max(0,Math.floor(ms/1000)); const days=Math.floor(total/86400); const h=Math.floor(total%86400/3600); const min=Math.floor(total%3600/60); const sec=total%60; return `${String(days).padStart(2,'0')} gg : ${String(h).padStart(2,'0')} hh : ${String(min).padStart(2,'0')} mm : ${String(sec).padStart(2,'0')} ss`; }
function isLineupLocked(){
  if (!currentMatch) return true;
  if (String(currentMatch.status||'')==='finished') return true;
  if (currentMatch.adminOverrideOpen === true) return false;
  if (matchHasStarted()) return true;
  return currentMatch.lineupLocked === true;
}
function currentPlayer(){
  if (!isPlayer()) return null;
  const id = window.currentUserData?.playerId;
  return players.find(p => p.id === id) || players.find(p => p.userId === uid()) || null;
}
function currentPlayerInLineup(){ const p=currentPlayer(); return !!p && lineup.includes(p.id); }
function formatDate(d){ return d ? d.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'}) : ''; }
function formatDateTime(d){ return d ? d.toLocaleString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : ''; }
function formatDateOnly(d){ return d ? d.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'}) : ''; }
function statusLabel(s){ return ({scheduled:'PROGRAMMATA',voting_open:'VOTAZIONE APERTA',in_progress:'IN CORSO',finished:'TERMINATA',postponed:'RINVIATA',cancelled:'ANNULLATA'}[s] || String(s||'PROGRAMMATA').toUpperCase()); }
function statusClass(s){
  return s==='voting_open'?'open':
    (s==='postponed'?'warn':
    (s==='cancelled'?'closed':
    (s==='finished'?'status-finished':
    (s==='scheduled'?'status-scheduled':
    (s==='in_progress'?'status-in-progress':'')))));
}

async function loadPlayers(){
  const snap = await db.collection('players').where('leagueId','==',leagueId()).get();
  players = snap.docs.map(d=>({id:d.id,...d.data()})).filter(p=>p.active!==false);
  players.sort((a,b)=>playerName(a).localeCompare(playerName(b),'it'));
}
function selectHomeMatch(){
  if(!matches.length){ currentMatch=null; lineup=[]; return null; }

  // Se il Player e' convocato, la Home privilegia una partita in corso
  // o una TERMINATA con votazione ancora aperta. Solo in assenza di queste
  // viene mostrata la prossima partita futura.
  if(isPlayer()){
    const meId=window.currentUserData?.playerId;
    const activeNow=matches.filter(m=>{
      const d=parseDateTime(m);
      const eligible=!!meId && Array.isArray(m.lineup) && m.lineup.includes(meId);
      const status=String(m.status||'');
      const blocked=['cancelled','postponed'].includes(status);
      const started=!!d && Date.now()>=d.getTime();
      const isLive = started && eligible && !blocked && ['scheduled','in_progress','voting_open'].includes(status);
      const isFinishedVoting = status==='finished' && eligible && votingWindowOpen(m);
      return isLive || isFinishedVoting;
    });
    activeNow.sort((a,b)=>{
      const rank=s=>s==='voting_open'?0:(s==='in_progress'?1:(s==='finished'?0:2));
      return rank(a.status)-rank(b.status) || (parseDateTime(b)?.getTime()||0)-(parseDateTime(a)?.getTime()||0);
    });
    const future=matches.filter(m=>{
      const d=parseDateTime(m);
      return !!d && d.getTime()>Date.now() && !['finished','cancelled','postponed'].includes(String(m.status||''));
    });
    currentMatch=activeNow[0] || future[0] || null;
  }else{
    // La Home Admin privilegia: votazione aperta -> IN CORSO -> prossima futura.
    // Una TERMINATA con voto scaduto non puo' diventare la partita principale,
    // anche se l'Admin l'ha appena aperta dal Calendario.
    const activeNow = matches.filter(m=>{
      const d=parseDateTime(m);
      const status=String(m.status||'');
      const startedByTime=!!d && Date.now()>=d.getTime();
      return startedByTime && !['finished','cancelled','postponed'].includes(status);
    });
    activeNow.sort((a,b)=>(parseDateTime(b)?.getTime()||0)-(parseDateTime(a)?.getTime()||0));
    const votingFinished = matches.filter(m=>votingWindowOpen(m));
    const future=matches.filter(m=>{
      const d=parseDateTime(m);
      return !!d && d.getTime()>Date.now() && !['finished','cancelled','postponed'].includes(String(m.status||''));
    });
    currentMatch=votingFinished.sort((a,b)=>(b.finishedAt?.toDate?.()?.getTime?.()||0)-(a.finishedAt?.toDate?.()?.getTime?.()||0))[0] || activeNow[0] || future[0] || null;
  }
  lineup = currentMatch && Array.isArray(currentMatch.lineup) ? [...currentMatch.lineup] : [];
  return currentMatch;
}

async function loadMatches(){
  const snap = await db.collection('matches').where('leagueId','==',leagueId()).get();
  matches = snap.docs.map(d=>({id:d.id,...d.data()}));
  matches.sort((a,b)=>(parseDateTime(a)?.getTime()||0)-(parseDateTime(b)?.getTime()||0));
  selectHomeMatch();
}


// A36.10: ordinamento classifica giornaliera.
// L'unico criterio di ordinamento è il punteggio ricevuto dai voti, in ordine decrescente.
// Malus e netto NON influenzano in alcun modo la posizione in classifica.
// A parità di punti viene mantenuto l'ordine originale dei giocatori.
function sortDailyTeamRanking(rows) {
  return [...rows].sort((a, b) => {
    const pointsA = Number(a.points ?? a.votePoints ?? a.votesPoints ?? 0) || 0;
    const pointsB = Number(b.points ?? b.votePoints ?? b.votesPoints ?? 0) || 0;
    return pointsB - pointsA;
  });
}


function renderDashboard(){
  const matchAction=document.querySelector('[data-screen="match"]');
  if(matchAction){ const b=matchAction.querySelector('b'); const sm=matchAction.querySelector('small'); if(isPlayer()){if(b)b.textContent='Distinta di Gara';if(sm)sm.textContent='Distinta e votazione';}else{if(b)b.textContent='Distinta di Gara';if(sm)sm.textContent='Distinta e votazione';} }
  applyPlayerVisibility();
  const title=$('#matchTitle'), state=$('#voteState'), progress=$('#dashboardProgress'), eyebrow=$('#matchEyebrow');
  if(!title)return;
  if(!currentMatch){
    title.textContent='Nessuna partita disponibile';
    if(eyebrow) eyebrow.textContent='PARTITA';
    if(state){state.textContent='';state.className='pill';}
    if(progress)progress.textContent='';
    return;
  }
  const home=currentMatch.homeTeam||leagueTeam(), away=currentMatch.awayTeam||currentMatch.opponent||'Avversario';
  title.textContent=`${home} vs ${away}`;
  const started=matchHasStarted(currentMatch);
  if(eyebrow) eyebrow.textContent=started ? (String(currentMatch.status||'')==='finished' ? 'VOTAZIONE POST-PARTITA' : 'PARTITA IN CORSO') : 'PROSSIMA PARTITA';
  const meInLineup=isPlayer() && currentPlayerInLineup();
  let label='PROGRAMMATA';
  let cls='pill';
  if(started && String(currentMatch.status||'')==='finished' && meInLineup && votingWindowOpen(currentMatch)) { label='VOTA ORA'; cls='pill open'; }
  else if(started && String(currentMatch.status||'')==='finished' && meInLineup && !votingWindowOpen(currentMatch)) { label='VOTO SCADUTO'; cls='pill closed'; }
  else if(started) { label='IN CORSO'; cls='pill'; }
  else if(started) { label='IN CORSO'; cls='pill'; }
  else { label='PROSSIMA'; cls='pill'; }
  if(state){state.textContent=label;state.className=cls;}
  const countdown=$('#matchCountdown');
  if(countdown){
    const nextDate=parseDateTime(currentMatch);
    const isUpcoming=!!nextDate && nextDate.getTime()>Date.now() && ['scheduled'].includes(String(currentMatch.status||'scheduled'));
    if(isUpcoming){
      countdown.textContent=`⏳ Mancano ${formatNextMatchCountdown(nextDate.getTime()-Date.now())}`;
      countdown.classList.remove('hidden');
    }else{
      countdown.textContent='';
      countdown.classList.add('hidden');
    }
  }
  const dashboardCard=$('#dashboardMatchCard');
  if(dashboardCard){
    const clickable=!!currentMatch;
    dashboardCard.classList.toggle('is-clickable',clickable);
    dashboardCard.setAttribute('aria-disabled',clickable?'false':'true');
  }
  if(progress){
    const n=Array.isArray(currentMatch.lineup)?currentMatch.lineup.length:0;
    if(isPlayer() && votingWindowOpen(currentMatch)) progress.textContent=`Voto disponibile ancora per ${formatCountdown(votingRemainingMs(currentMatch))}`;
    else progress.textContent=started ? `${n} giocatori in distinta` : `Distinta disponibile prima dell'inizio della partita`;
  }
}
async function loadLeague(){
  const snap=await db.collection('leagues').doc(leagueId()).get();
  window.currentLeagueData=snap.exists?snap.data():{};
}
async function refresh(){
  try{
    await loadLeague(); await loadPlayers(); await loadMatches();
    renderLeague(); renderDashboard(); applyPlayerVisibility(); renderMatch(); renderPlayers(); renderCalendar(); await renderAdminPlayers(); await loadPendingRegistrations(); await renderAdminManagement(); await renderPlayerVisibilityForm();
    await syncPublicResultsForAdmin();
    await renderRanking();
    // Dopo il login aspettiamo che Firebase Auth abbia una sessione realmente
    // utilizzabile dalle Firestore Rules, quindi carichiamo il tabellino prima
    // di ricostruire lo stato personale della votazione.
    await loadCurrentMatchDetails(currentMatch?.id);
    await loadOwnVoteState(currentMatch?.id);
    renderMatch();
    updateProgress();
  }catch(e){ console.error(e); const msg=$('#voteMsg'); if(msg) msg.textContent='❌ Errore nel caricamento dei dati da Firebase.'; }
}
const BUILTIN_LEAGUE_THEMES = {
  demo: {
    primary: '#159447',
    primaryDark: '#0d6b32',
    primarySoft: '#effaf3',
    border: '#cfe7d6',
    muted: '#5a7463',
    logo: 'assets/juvenilia-uras-logo.jpg',
    logoAlt: 'Stemma Juvenilia Hockey Uras'
  },
  'serie-a1-prato-maschile': {
    logo: 'assets/juvenilia-uras-logo.jpg',
    logoAlt: 'Stemma Juvenilia Hockey Uras'
  }
};

function applyLeagueTheme(){
  const root=document.documentElement;
  const data=window.currentLeagueData||{};
  const builtIn=BUILTIN_LEAGUE_THEMES[leagueId()]||{};
  const theme=Object.assign({},builtIn,data.theme||{});
  if(theme.primary) root.style.setProperty('--league-primary',theme.primary);
  if(theme.primaryDark) root.style.setProperty('--league-primary-dark',theme.primaryDark);
  if(theme.primarySoft) root.style.setProperty('--league-primary-soft',theme.primarySoft);
  if(theme.border) root.style.setProperty('--league-border',theme.border);
  if(theme.muted) root.style.setProperty('--league-muted',theme.muted);
  const meta=document.querySelector('meta[name="theme-color"]');
  if(meta && (theme.primaryDark||theme.primary)) meta.setAttribute('content',theme.primaryDark||theme.primary);

  const logo=$('#leagueLogo');
  const fallback=$('#leagueLogoFallback');
  const logoUrl=theme.logoUrl||theme.logo||'';
  if(logo){
    if(logoUrl){
      logo.src=logoUrl;
      logo.alt=theme.logoAlt||`Stemma ${data.name||'della lega'}`;
      logo.classList.remove('hidden');
      if(fallback) fallback.classList.add('hidden');
    }else{
      logo.removeAttribute('src');
      logo.classList.add('hidden');
      if(fallback) fallback.classList.remove('hidden');
    }
  }
}

function renderLeague(){
  if(!window.currentLeagueData) return;
  $('#leagueName').textContent=window.currentLeagueData.name||leagueTeam()||'Best&Fairest';
  $('#seasonName').textContent=`Stagione ${window.currentLeagueData.season||''}`;
  applyLeagueTheme();
}

async function loadMatchSummary(matchId=currentMatch?.id){
  currentMatchSummary={};
  if(!matchId) return;
  const snap=await db.collection('matches').doc(matchId).collection('summary').doc('main').get();
  currentMatchSummary=snap.exists?({id:snap.id,...(snap.data()||{})}):{};
  return currentMatchSummary;
}
function matchScoreText(m, summary){
  const home=m?.homeTeam||leagueTeam(), away=m?.awayTeam||m?.opponent||'Avversario';
  const has=Number.isInteger(Number(summary?.homeScore)) && Number.isInteger(Number(summary?.awayScore));
  return has ? `${escapeHtml(home)} <b>${Number(summary.homeScore)} - ${Number(summary.awayScore)}</b> ${escapeHtml(away)}` : `${escapeHtml(home)} <b>–</b> ${escapeHtml(away)}`;
}
async function loadPublicMatchResults(matchId){
  const totals={};
  try{
    const snap=await db.collection('matches').doc(matchId).collection('publicResults').get();
    snap.forEach(d=>{totals[d.id]={id:d.id,...(d.data()||{})};});
  }catch(e){ console.error('Risultati pubblici partita:',e); }
  return totals;
}
async function renderPlayedMatches(){
  const box=$('#playedMatchesList');
  if(!box) return;
  const finished=matches
    .filter(m=>String(m.status||'')==='finished')
    .sort((a,b)=>(parseDateTime(b)?.getTime()||0)-(parseDateTime(a)?.getTime()||0));

  if(!finished.length){
    box.innerHTML='<div class="card"><p class="muted">Nessuna partita disputata ancora.</p></div>';
    return;
  }

  // Vista compatta: inizialmente viene mostrata solo una riga per partita.
  // Il dettaglio completo viene caricato e aperto solo al click sulla singola partita.
  box.innerHTML=`<div class="card"><p class="muted">Clicca su una partita per aprire il risultato completo e le statistiche.</p></div>`+
    finished.map(m=>{
      const phase=String(m.fase||'Andata');
      const round=m.giornata||m.day||'';
      const when=formatDateOnly(parseDateTime(m));
      const home=m.homeTeam||leagueTeam();
      const away=m.awayTeam||m.opponent||'Avversario';
      return `<div class="played-match-accordion" data-played-match="${escapeHtml(m.id)}">
        <button type="button" class="played-match-summary" aria-expanded="false">
          <span class="played-match-summary-text">
            <b>${escapeHtml(when)}</b>
            <span class="played-match-dot">·</span>
            <span>${escapeHtml(phase)}</span>
            ${round?`<span class="played-match-dot">·</span><span>G${escapeHtml(round)}</span>`:''}
            <span class="played-match-dot">·</span>
            <span>${escapeHtml(home)} vs ${escapeHtml(away)}</span>
          </span>
          <span class="played-match-chevron" aria-hidden="true">⌄</span>
        </button>
        <div class="played-match-body" hidden><span class="muted">Caricamento riepilogo...</span></div>
      </div>`;
    }).join('');
}

async function loadPlayedMatchDetails(matchId, card){
  if(!matchId||!card) return;
  const m=matches.find(x=>x.id===matchId);
  const body=card.querySelector('.played-match-body');
  if(!m||!body) return;
  if(card.dataset.loaded==='1') return;

  body.innerHTML='<span class="muted">Caricamento riepilogo...</span>';
  try{
    const [sumSnap,statsSnap,results]=await Promise.all([
      db.collection('matches').doc(m.id).collection('summary').doc('main').get().catch(()=>null),
      db.collection('matches').doc(m.id).collection('stats').get().catch(()=>null),
      loadPublicMatchResults(m.id)
    ]);

    const summary=sumSnap?.exists?(sumSnap.data()||{}):{};
    const statMap={};
    statsSnap?.forEach(d=>{ statMap[d.id]=d.data()||{}; });
    const played=Object.keys(statMap).filter(id=>statMap[id].appearance===1||statMap[id].appearance===true);
    const ranked=Object.entries(results).sort((a,b)=>(b[1].points||0)-(a[1].points||0)||(b[1].first||0)-(a[1].first||0)||(b[1].second||0)-(a[1].second||0)||(b[1].third||0)-(a[1].third||0));
    const top=ranked.filter(([,r])=>(r.points||0)>0);
    const mvp=top.length?players.find(p=>p.id===top[0][0]):null;
    const tie=top.length>1 && (top[1][1].points||0)===(top[0][1].points||0) && (top[1][1].first||0)===(top[0][1].first||0) && (top[1][1].second||0)===(top[0][1].second||0) && (top[1][1].third||0)===(top[0][1].third||0);
    const mvpText=mvp
      ? (tie
        ? `⭐ MVP ex aequo: <b>${escapeHtml(playerName(mvp))}</b> e <b>${escapeHtml(playerName(players.find(p=>p.id===top[1][0])||{}))}</b>`
        : `⭐ MVP: <b>${escapeHtml(playerName(mvp))}</b> <span class="sub">${top[0][1].points||0} pt</span>`)
      : '⭐ MVP: non disponibile';
    const showPlayerVotes=!isPlayer();
    const rows=played.map(id=>{
      const p=players.find(x=>x.id===id); if(!p) return '';
      const st=statMap[id]||{}; const r=results[id]||{};
      return `<div class="played-player-row"><b>${escapeHtml(playerName(p))}</b><span>${statNum(st.goals)}</span><span>${statNum(st.assists)}</span><span>${statNum(st.green)}</span><span>${statNum(st.yellow)}</span><span>${statNum(st.red)}</span>${showPlayerVotes?`<span>${statNum(r.points)} pt</span>`:''}</div>`;
    }).join('');
    const scorers=[];
    played.forEach(id=>{
      const p=players.find(x=>x.id===id); const st=statMap[id]||{}; if(!p) return;
      for(let i=0;i<statNum(st.goals);i++) scorers.push(playerName(p));
    });
    const scorersText=scorers.length
      ? `<div class="scorers-line"><b>⚽ Marcatori:</b> ${scorers.map(n=>escapeHtml(n)).join(', ')}</div>`
      : '';

    body.innerHTML=`<div class="played-score">${matchScoreText(m,summary)}</div>${scorersText}${!isPlayer()?`<div class="mvp-box">${mvpText}</div>`:''}<div class="played-stats"><div class="played-player-row played-header"><span>Giocatore</span><span>Gol</span><span>Assist</span><span>Verdi</span><span>Gialli</span><span>Rossi</span>${!isPlayer()?'<span>Voto</span>':''}</div>${rows||'<p class="muted">Nessuna statistica registrata.</p>'}</div>`;
    card.dataset.loaded='1';
  }catch(e){
    console.error('Dettaglio partita disputata:',e);
    body.innerHTML='<p class="muted">Impossibile caricare il riepilogo della partita.</p>';
  }
}


async function loadMatchStats(matchId=currentMatch?.id){
  currentMatchStats={};
  if(!matchId) return currentMatchStats;
  // La distinta della partita corrente determina i documenti da leggere.
  // Non usiamo la LIST della sottocollezione stats.
  const ids=Array.isArray(currentMatch?.lineup)?[...new Set(currentMatch.lineup)]:[];
  if(!ids.length) return currentMatchStats;
  const refs=ids.map(playerId=>db.collection('matches').doc(matchId).collection('stats').doc(playerId));
  const snaps=await Promise.all(refs.map(ref=>ref.get()));
  snaps.forEach((snap,i)=>{
    if(snap.exists) currentMatchStats[ids[i]]={id:ids[i],...(snap.data()||{})};
  });
  return currentMatchStats;
}
async function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }
async function waitForAuthReady(){
  const expected=window.currentUserData?.uid || firebase.auth().currentUser?.uid || '';
  for(let i=0;i<10;i++){
    const u=firebase.auth().currentUser;
    if(u && (!expected || u.uid===expected)){
      try{ await u.getIdToken(); }catch(_){}
      return;
    }
    await sleep(100);
  }
}
async function loadCurrentMatchDetails(matchId=currentMatch?.id){
  if(!matchId) return false;
  await waitForAuthReady();
  if(matchDetailsPromise && matchDetailsFor===matchId) return matchDetailsPromise;
  matchDetailsFor=matchId;
  matchDetailsPromise=(async()=>{
    let statsOk=false, summaryOk=false;
    for(let attempt=1;attempt<=3;attempt++){
      const results=await Promise.allSettled([loadMatchStats(matchId),loadMatchSummary(matchId)]);
      statsOk=results[0].status==='fulfilled';
      summaryOk=results[1].status==='fulfilled';
      if(statsOk && summaryOk) break;
      if(attempt<3) await sleep(attempt*400);
    }
    if(!statsOk) console.error('Caricamento statistiche partita non riuscito dopo 3 tentativi.');
    if(!summaryOk) console.error('Caricamento riepilogo partita non riuscito dopo 3 tentativi.');
    if(currentMatch?.id===matchId) renderMatchStats();
    return statsOk || summaryOk;
  })().finally(()=>{ matchDetailsPromise=null; });
  return matchDetailsPromise;
}
function statNum(v){ const n=Number(v); return Number.isFinite(n)&&n>=0?Math.floor(n):0; }
let autoFinalizeAttempted=new Set();
function tabellinoAutoBloccato(m=currentMatch){
  if(!m || String(m.status||'')!=='finished') return false;
  if(m.votingClosed===true) return true;
  const deadline=votingDeadlineDate(m);
  return !!deadline && Date.now()>=deadline.getTime();
}
async function autoFinalizeTabellinoIfNeeded(m=currentMatch){
  if(!isAdmin() || !m || String(m.status||'')!=='finished' || m.tabellinoFinalizzato===true || m.tabellinoExceptionOpen===true) return false;
  if(!tabellinoAutoBloccato(m)) return false;
  if(autoFinalizeAttempted.has(m.id)) return false;
  autoFinalizeAttempted.add(m.id);
  try{
    await db.collection('matches').doc(m.id).update({tabellinoFinalizzato:true,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    if(currentMatch?.id===m.id) currentMatch.tabellinoFinalizzato=true;
    return true;
  }catch(e){
    console.error('Finalizzazione automatica tabellino:',e);
    autoFinalizeAttempted.delete(m.id);
    return false;
  }
}
function renderMatchStats(){
  const card=$('#matchStatsCard'), box=$('#matchStatsList'), resultBox=$('#matchResultEditor');
  const saveBtn=$('#saveMatchStatsBtn'), msg=$('#matchStatsMsg');
  const finalizeBtn=$('#finalizeMatchStatsBtn'), exceptionalBtn=$('#exceptionalEditStatsBtn');
  if(!card||!box||!currentMatch) return;
  const canEditBase=isAdmin() && String(currentMatch.status||'')!=='cancelled';
  const finalized=currentMatch.tabellinoFinalizzato===true;
  const autoLocked=tabellinoAutoBloccato(currentMatch);
  const exceptionalOpen=matchStatsExceptionOpen===true;
  const canEdit=canEditBase && ((!finalized && !autoLocked) || exceptionalOpen);
  const isFinished=String(currentMatch.status||'')==='finished';
  void autoFinalizeTabellinoIfNeeded(currentMatch);

  // Il tabellino deve restare visibile all'Admin anche quando non ci sono ancora stats,
  // mentre al Player mostriamo la lettura solo quando esistono dati.
  card.classList.toggle('hidden',!canEdit && !Object.keys(currentMatchStats).length && !Object.keys(currentMatchSummary).length);

  if(resultBox){
    const localIsHome=isLocalTeamName(currentMatch.homeTeam||leagueTeam());
    const opponentTeam=localIsHome?(currentMatch.awayTeam||currentMatch.opponent||'Avversario'):(currentMatch.homeTeam||leagueTeam());
    const localGoals=Object.values(currentMatchStats||{}).reduce((sum,st)=>sum + (statNum(st?.appearance) ? statNum(st?.goals) : 0),0);
    const opponentScore=Number.isFinite(Number(currentMatchSummary?.[localIsHome?'awayScore':'homeScore'])) ? Number(currentMatchSummary?.[localIsHome?'awayScore':'homeScore']) : 0;
    if(canEdit){
      resultBox.innerHTML=`<div class="result-editor-title">🏟️ Risultato partita</div><div class="result-inputs"><div class="result-auto-score"><span class="result-team">${escapeHtml(localTeam())}</span><strong id="localScoreDisplay">${localGoals}</strong><small>gol nel tabellino</small></div><span>−</span><label>${escapeHtml(opponentTeam)}<input id="opponentScore" type="number" min="0" step="1" value="${escapeHtml(String(opponentScore))}"></label></div>`;
    }else{
      resultBox.innerHTML=`<div class="result-editor-title">🏟️ Risultato partita</div><div class="result-readonly"><span>${escapeHtml(localIsHome?(currentMatch.homeTeam||leagueTeam()):(currentMatch.awayTeam||currentMatch.opponent||'Avversario'))}</span><strong>${Number(currentMatchSummary?.homeScore??0)} - ${Number(currentMatchSummary?.awayScore??0)}</strong><span>${escapeHtml(localIsHome?(currentMatch.awayTeam||currentMatch.opponent||'Avversario'):(currentMatch.homeTeam||leagueTeam()))}</span></div>`;
    }
  }

  const ids=Array.isArray(currentMatch.lineup)?currentMatch.lineup:[];
  const rows=ids.map(id=>{
    const p=players.find(x=>x.id===id)||{id}; const st=currentMatchStats[id]||{}; const played=st.appearance===1||st.appearance===true;
    if(canEdit){
      return `<div class="stats-row" data-stat-player="${escapeHtml(id)}">
        <div><b>${escapeHtml(playerName(p))}</b><div class="stats-note">${played?'Presenza registrata':'Non ancora registrato come presente'}</div></div>
        <label class="stats-field inline-check"><span>Pres.</span><input class="stat-appearance" type="checkbox" ${played?'checked':''}></label>
        <label class="stats-field"><span>Gol</span><input class="stat-goals" type="number" min="0" step="1" value="${statNum(st.goals)}" ${played?'':'disabled'}></label>
        <label class="stats-field"><span>Assist</span><input class="stat-assists" type="number" min="0" step="1" value="${statNum(st.assists)}" ${played?'':'disabled'}></label>
        <label class="stats-field"><span>Verdi</span><input class="stat-green" type="number" min="0" step="1" value="${statNum(st.green)}" ${played?'':'disabled'}></label>
        <label class="stats-field"><span>Gialli</span><input class="stat-yellow" type="number" min="0" step="1" value="${statNum(st.yellow)}" ${played?'':'disabled'}></label>
        <label class="stats-field"><span>Rossi</span><input class="stat-red" type="number" min="0" step="1" value="${statNum(st.red)}" ${played?'':'disabled'}></label>
      </div>`;
    }
    if(!played && !Object.keys(currentMatchStats).length) return '';
    return `<div class="stats-row stats-readonly" data-stat-player="${escapeHtml(id)}"><div><b>${escapeHtml(playerName(p))}</b></div><span>⚽ ${statNum(st.goals)}</span><span>🎯 ${statNum(st.assists)}</span><span>🟩 ${statNum(st.green)}</span><span>🟨 ${statNum(st.yellow)}</span><span>🟥 ${statNum(st.red)}</span></div>`;
  }).join('');

  if(canEdit){
    box.innerHTML=`<div class="stats-grid stats-header"><span>Giocatore</span><span>Pres.</span><span>Gol</span><span>Assist</span><span>Verdi</span><span>Gialli</span><span>Rossi</span></div>${rows||'<p class="muted">Nessun giocatore.</p>'}`;
  }else{
    box.innerHTML=`<div class="stats-row stats-header"><span>Giocatore</span><span>Gol</span><span>Assist</span><span>Verdi</span><span>Gialli</span><span>Rossi</span></div>${rows||'<p class="muted">Nessuna statistica registrata.</p>'}`;
  }

  if(msg){
    if(exceptionalOpen){
      msg.textContent='⚠️ Modifica eccezionale attiva. Salva la correzione per richiudere il tabellino.';
      msg.className='warning';
    }else if(finalized){
      msg.textContent='🔒 Tabellino finalizzato e protetto. Clicca “Modifica eccezionale” per una correzione amministrativa.';
      msg.className='muted';
    }else if(autoLocked){
      msg.textContent='🔒 Tabellino bloccato automaticamente al termine della finestra di voto. Clicca “Modifica eccezionale” per una correzione amministrativa.';
      msg.className='muted';
    }else{
      msg.textContent=''; msg.className='success';
    }
  }
  if(saveBtn){
    const showSave=canEdit;
    saveBtn.style.display=showSave?'':'none';
    saveBtn.textContent=exceptionalOpen?'💾 Salva correzione':'💾 Salva tabellino';
  }
  if(finalizeBtn){
    const already=finalized;
    finalizeBtn.style.display=(isAdmin()&&isFinished&&!already&&!autoLocked&&!exceptionalOpen)?'':'none';
    finalizeBtn.disabled=!(isFinished&&Object.keys(currentMatchSummary).length>0);
  }
  if(exceptionalBtn){
    exceptionalBtn.style.display=(isAdmin()&&isFinished&&(finalized||autoLocked)&&!exceptionalOpen)?'':'none';
  }
}
async function saveMatchStats(){
  if(!isAdmin()||!currentMatch) return;
  if((currentMatch.tabellinoFinalizzato===true || tabellinoAutoBloccato(currentMatch)) && !matchStatsExceptionOpen) return; 
  const btn=$('#saveMatchStatsBtn'), rows=[...document.querySelectorAll('#matchStatsList .stats-row[data-stat-player]')];
  if(btn){btn.disabled=true;btn.textContent='⏳ Salvataggio...';}
  try{
    const batch=db.batch();
    const summaryRef=db.collection('matches').doc(currentMatch.id).collection('summary').doc('main');
    let localScore=0;
    rows.forEach(row=>{
      const playerId=row.dataset.statPlayer;
      const appearance=row.querySelector('.stat-appearance')?.checked;
      const goals=statNum(row.querySelector('.stat-goals')?.value);
      if(appearance) localScore += goals;
      const ref=db.collection('matches').doc(currentMatch.id).collection('stats').doc(playerId);
      if(!appearance){ batch.delete(ref); return; }
      const data={appearance:1,goals,assists:statNum(row.querySelector('.stat-assists')?.value),green:statNum(row.querySelector('.stat-green')?.value),yellow:statNum(row.querySelector('.stat-yellow')?.value),red:statNum(row.querySelector('.stat-red')?.value)};
      batch.set(ref,data,{merge:true});
    });
    const opponentScore=statNum($('#opponentScore')?.value);
    const localIsHome=isLocalTeamName(currentMatch.homeTeam||leagueTeam());
    const homeScore=localIsHome?localScore:opponentScore;
    const awayScore=localIsHome?opponentScore:localScore;
    batch.set(summaryRef,{homeScore,awayScore,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
    await batch.commit();
    if(matchStatsExceptionOpen){
      await db.collection('matches').doc(currentMatch.id).update({tabellinoExceptionOpen:false,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
      currentMatch.tabellinoExceptionOpen=false;
    }
    await loadCurrentMatchDetails(currentMatch.id); matchStatsDraftDirty=false; matchStatsExceptionOpen=false; renderMatchStats(); await renderPlayedMatches();
    const msg=$('#matchStatsMsg'); if(msg){ msg.textContent='✅ Tabellino salvato.'; msg.className='success'; }
  }catch(e){
    console.error('Salvataggio statistiche:',e);
    alert(e.code==='permission-denied'?'❌ Firebase ha rifiutato il salvataggio del tabellino.':'❌ Impossibile salvare il tabellino.');
  }finally{ if(btn){btn.disabled=false;btn.textContent='💾 Salva tabellino';} }
}
async function finalizeMatchStats(){
  if(!isAdmin()||!currentMatch||String(currentMatch.status||'')!=='finished') return;
  if(currentMatch.tabellinoFinalizzato===true) return;
  if(!Object.keys(currentMatchSummary).length){
    alert('⚠️ Prima salva il tabellino con il risultato della partita.');
    return;
  }
  const ok=confirm('✅ FINALIZZA TABELLINO\n\nDopo la finalizzazione il tabellino diventerà in sola lettura.\n\nPer correggerlo in seguito sarà necessario usare “Modifica eccezionale”.\n\nVuoi finalizzare il tabellino?');
  if(!ok) return;
  const btn=$('#finalizeMatchStatsBtn'); if(btn){btn.disabled=true;btn.textContent='⏳ Finalizzazione...';}
  try{
    await db.collection('matches').doc(currentMatch.id).update({tabellinoFinalizzato:true,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    currentMatch.tabellinoFinalizzato=true;
    matchStatsExceptionOpen=false;
    renderMatchStats();
  }catch(e){
    console.error('Finalizzazione tabellino:',e);
    alert(e.code==='permission-denied'?'❌ Firebase ha rifiutato la finalizzazione. Verifica le Rules.':'❌ Impossibile finalizzare il tabellino.');
  }finally{ if(btn){btn.disabled=false;btn.textContent='✅ Finalizza tabellino';} }
}
async function openExceptionalStatsEdit(){
  if(!isAdmin()||!currentMatch||String(currentMatch.status||'')!=='finished') return;
  const locked=currentMatch.tabellinoFinalizzato===true || tabellinoAutoBloccato(currentMatch);
  if(!locked || currentMatch.tabellinoExceptionOpen===true) return;
  const ok=confirm('⚠️ MODIFICA ECCEZIONALE\n\nStai per aprire temporaneamente un tabellino già protetto.\nLa partita resterà TERMINATA e la distinta resterà bloccata.\n\nVuoi procedere?');
  if(!ok) return;
  const btn=$('#exceptionalEditStatsBtn');
  if(btn){btn.disabled=true;btn.textContent='⏳ Apertura...';}
  try{
    await db.collection('matches').doc(currentMatch.id).update({tabellinoExceptionOpen:true,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    currentMatch.tabellinoExceptionOpen=true;
    matchStatsExceptionOpen=true;
    renderMatchStats();
  }catch(e){
    console.error('Apertura modifica eccezionale:',e);
    alert(e.code==='permission-denied'?'❌ Firebase ha rifiutato la modifica eccezionale. Verifica le Rules.':'❌ Impossibile aprire la modifica eccezionale.');
  }finally{ if(btn){btn.disabled=false;btn.textContent='✏️ Modifica eccezionale';} }
}

async function loadSeasonStats(){
  const totals=Object.fromEntries(players.map(p=>[p.id,{...p,appearances:0,goals:0,assists:0,green:0,yellow:0,red:0}]));
  try{
    await Promise.all(matches.map(async m=>{
      const snap=await db.collection('matches').doc(m.id).collection('stats').get();
      snap.forEach(d=>{
        if(!totals[d.id]) return;
        const x=d.data()||{};
        if(x.appearance===1 || x.appearance===true) totals[d.id].appearances+=1;
        totals[d.id].goals+=statNum(x.goals); totals[d.id].assists+=statNum(x.assists); totals[d.id].green+=statNum(x.green); totals[d.id].yellow+=statNum(x.yellow); totals[d.id].red+=statNum(x.red);
      });
    }));
  }catch(e){console.error('Statistiche stagione:',e);}
  return Object.values(totals).sort((a,b)=>b.goals-a.goals||b.assists-a.assists||b.appearances-a.appearances||playerName(a).localeCompare(playerName(b),'it'));
}
async function renderSeasonStats(){
  const box=$('#seasonStatsTable'); if(!box) return;
  const rows=await loadSeasonStats();
  box.innerHTML=`<div class="card"><span class="eyebrow">STAGIONE</span><h3>Statistiche giocatori</h3><p class="muted">Riepilogo cumulativo delle partite disputate. I dati di ogni singola partita restano conservati nel relativo tabellino.</p><div class="stats-season"><div class="stats-header"><span>Giocatore</span><span>Pres.</span><span>Gol</span><span>Assist</span><span>Verdi</span><span>Gialli</span><span>Rossi</span></div>${rows.map(p=>`<div class="stats-row"><div><b>${escapeHtml(playerName(p))}</b></div><span>${p.appearances}</span><span>${p.goals}</span><span>${p.assists}</span><span>${p.green}</span><span>${p.yellow}</span><span>${p.red}</span></div>`).join('')}</div></div>`;
}


// ---------- A35.0 · Classifiche Squadra Admin ----------
async function loadStoricoSquadraData(){
  if(!isAdmin() && !isPlayer()) return [];
  const ordered=[...matches].sort((a,b)=>(parseDateTime(a)?.getTime()||0)-(parseDateTime(b)?.getTime()||0));
  const out=[];
  for(const m of ordered){
    if(!Array.isArray(m.lineup) || !m.lineup.length) continue;
    const reads=[
      db.collection('matches').doc(m.id).collection('stats').get(),
      db.collection('matches').doc(m.id).collection('publicResults').get(),
      db.collection('matches').doc(m.id).collection('summary').doc('main').get()
    ];
    if(isAdmin()) reads.push(db.collection('matches').doc(m.id).collection('votes').get());
    const snaps=await Promise.all(reads);
    const statsSnap=snaps[0], publicResultsSnap=snaps[1], summarySnap=snaps[2];
    const stats={};
    statsSnap.forEach(d=>stats[d.id]=d.data()||{});
    const publicResults={};
    publicResultsSnap.forEach(d=>publicResults[d.id]=d.data()||{});
    const votes={};
    if(isAdmin() && snaps[3]) snaps[3].forEach(d=>votes[d.id]=d.data()||{});
    const pointsByPlayer={};
    Object.entries(publicResults).forEach(([playerId,r])=>{
      pointsByPlayer[playerId]={points:statNum(r.points),votes:statNum(r.votes)};
    });

    const eligibleIds=new Set(
      m.lineup.filter(id => {
        const s=stats[id]||{};
        return s.appearance===1 || s.appearance===true;
      })
    );
    const rows=m.lineup.map(id=>{
      const p=players.find(x=>x.id===id)||{id,nome:'',cognome:''};
      const s=stats[id]||{};
      const eligible=eligibleIds.has(id);
      const vp=eligible?(pointsByPlayer[id]?.points||0):null;
      const green=eligible?statNum(s.green):null;
      const yellow=eligible?statNum(s.yellow):null;
      const red=eligible?statNum(s.red):null;
      const malus=eligible?(green * 1+yellow * 3+red*10):null;
      const net=eligible?(vp-malus):null;
      const voted=eligible && !!p.userId && Object.prototype.hasOwnProperty.call(
        Object.fromEntries(Object.keys(votes).map(k=>[k,true])), String(p.userId)
      );
      return {id,name:playerName(p),eligible,voted,votePoints:vp,green,yellow,red,malus,net};
    });

    // La classifica giornaliera deve essere determinata esclusivamente dai punti voto.
    // I giocatori non schierati restano in coda e non partecipano alla graduatoria dei voti.
    const sortedEligibleRows=sortDailyTeamRanking(rows.filter(r=>r.eligible));
    const nonEligibleRows=rows.filter(r=>!r.eligible);
    const sortedRows=[...sortedEligibleRows,...nonEligibleRows];
    const eligibleRows=sortedEligibleRows;
    const teamVotePoints=eligibleRows.reduce((s,r)=>s+(r.votePoints||0),0);
    const teamMalus=eligibleRows.reduce((s,r)=>s+(r.malus||0),0);
    const teamNet=teamVotePoints-teamMalus;
    const votedCount=eligibleRows.filter(r=>r.voted).length;
    const summary=summarySnap.exists?(summarySnap.data()||{}):{};
    out.push({match:m,rows:sortedRows,teamVotePoints,teamMalus,teamNet,votedCount,eligibleCount:sortedEligibleRows.length,summary});
  }
  return out;
}

function storicoDateLabel(m){
  const d=parseDateTime(m);
  return d ? formatDateTime(d) : 'Data non disponibile';
}
function storicoDayLabel(m){
  const g=m.giornata ?? m.day ?? m.round ?? m.matchday;
  return g!==undefined && g!==null && String(g).trim()!=='' ? `Giornata ${g}` : 'Giornata';
}
function storicoScoreLabel(m,summary){
  const home=m.homeTeam||leagueTeam(), away=m.awayTeam||m.opponent||'Avversario';
  const hs=Number(summary?.homeScore), as=Number(summary?.awayScore);
  return Number.isInteger(hs)&&Number.isInteger(as) ? `${home} ${hs} - ${as} ${away}` : `${home} - ${away}`;
}

async function renderStoricoSquadra(){
  const box=$('#storicoSquadraList');
  if(!box || (!isAdmin() && !isPlayer())) return;
  box.innerHTML='<div class="card"><p class="muted">Caricamento Classifiche Squadra…</p></div>';
  try{
    const data=await loadStoricoSquadraData();
    if(!data.length){
      box.innerHTML='<div class="card"><p class="muted">Non ci sono ancora giornate con una distinta registrata.</p></div>';
      return;
    }
    const options=data.map((x,i)=>`<option value="${i}">${escapeHtml(storicoDayLabel(x.match))} · ${escapeHtml(x.match.opponent||x.match.awayTeam||'Partita')}</option>`).join('');
    box.innerHTML=`
      <div class="card">
        <div class="section-head" style="margin-bottom:0">
          <div><span class="eyebrow">CONSULTAZIONE</span><h3>Seleziona giornata</h3></div>
          <select id="storicoDaySelect">${options}</select>
        </div>
      </div>
      <div id="storicoDayContent"></div>`;
    const renderDay=(idx)=>{
      const x=data[Number(idx)]||data[0];
      const rows=x.rows;
      const body=rows.map(r=>{
        if(!r.eligible){
          return `<tr class="not-lineup"><td>${escapeHtml(r.name)}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>${isAdmin()?'<td class="storico-status">— Non schierato</td>':''}</tr>`;
        }
        return `<tr>
          <td><b>${escapeHtml(r.name)}</b></td>
          <td>${r.votePoints}</td>
          <td>${r.green}</td><td>${r.yellow}</td><td>${r.red}</td>
          <td>−${r.malus}</td><td class="storico-net">${r.net}</td>
          ${isAdmin()?`<td class="storico-status">${r.voted?'✓ Ha votato':'○ Non ha votato'}</td>`:''}
        </tr>`;
      }).join('');
      const mobileCards=rows.map(r=>{
        if(!r.eligible){
          return `<article class="storico-mobile-card not-lineup">
            <div class="storico-mobile-head"><b>${escapeHtml(r.name)}</b><span class="storico-mobile-badge muted">— Non schierato</span></div>
            <div class="storico-mobile-grid"><div><small>Punti voto</small><strong>—</strong></div><div><small>Malus</small><strong>—</strong></div><div><small>Netto</small><strong>—</strong></div></div>
          </article>`;
        }
        return `<article class="storico-mobile-card">
          <div class="storico-mobile-head"><b>${escapeHtml(r.name)}</b>${isAdmin()?`<span class="storico-mobile-badge ${r.voted?'is-voted':'not-voted'}">${r.voted?'✓ Ha votato':'○ Non ha votato'}</span>`:''}</div>
          <div class="storico-mobile-primary"><div><small>Punti voto</small><strong>${r.votePoints}</strong></div><div><small>Malus</small><strong>−${r.malus}</strong></div><div><small>Netto</small><strong>${r.net}</strong></div></div>
          <div class="storico-mobile-cards"><span>🟩 ${r.green}</span><span>🟨 ${r.yellow}</span><span>🟥 ${r.red}</span></div>
        </article>`;
      }).join('');
      const el=$('#storicoDayContent');
      el.innerHTML=`
        <div class="card storico-day">
          <div class="storico-day-head">
            <div><span class="eyebrow">${escapeHtml(storicoDayLabel(x.match))}</span><h3>${escapeHtml(storicoScoreLabel(x.match,x.summary))}</h3><p class="muted">${escapeHtml(storicoDateLabel(x.match))}</p></div>
          </div>
          <div class="storico-day-meta">
            <span class="storico-metric">🗳️ Punti votazioni <b>${x.teamVotePoints}</b></span>
            <span class="storico-metric">➖ Malus <b>−${x.teamMalus}</b></span>
            <span class="storico-metric">🏆 Netto <b>${x.teamNet}</b></span>
            ${isAdmin()?`<span class="storico-metric">👥 Partecipazione <b>${x.votedCount}/${x.eligibleCount}</b></span>`:''}
          </div>
          <div class="storico-table-wrap" style="margin-top:14px">
            <table class="storico-table">
              <thead><tr><th>Player</th><th>Punti voto</th><th>🟩</th><th>🟨</th><th>🟥</th><th>Malus</th><th>Netto</th>${isAdmin()?'<th>Partecipazione</th>':''}</tr></thead>
              <tbody>${body}</tbody>
            </table>
          </div>
          <div class="storico-mobile-list" aria-label="Verifica mobile giocatori">${mobileCards}</div>
          <div class="storico-day-total">
            <span class="storico-metric">Verdi −1 cad.</span>
            <span class="storico-metric">Gialli −3 cad.</span>
            <span class="storico-metric">Rossi −10 cad.</span>
          </div>
        </div>`;
    };
    $('#storicoDaySelect').addEventListener('change',e=>renderDay(e.target.value));
    renderDay(0);

    // Riepilogo totale stagione: aggrega tutte le giornate dello Classifiche Squadra.
    const seasonTotals={};
    data.forEach(x=>{
      x.rows.filter(r=>r.eligible).forEach(r=>{
        if(!seasonTotals[r.id]) seasonTotals[r.id]={id:r.id,name:r.name,played:0,votePoints:0,green:0,yellow:0,red:0,malus:0,net:0,voted:0};
        const t=seasonTotals[r.id];
        t.played+=1;
        t.votePoints+=Number(r.votePoints)||0;
        t.green+=Number(r.green)||0;
        t.yellow+=Number(r.yellow)||0;
        t.red+=Number(r.red)||0;
        t.malus+=Number(r.malus)||0;
        t.net+=Number(r.net)||0;
        if(r.voted)t.voted+=1;
      });
    });
    const seasonRows=Object.values(seasonTotals).sort((a,b)=>(b.net-a.net)||(b.votePoints-a.votePoints)||a.name.localeCompare(b.name));
    const seasonBody=seasonRows.map((r,i)=>`<tr>
      <td><b>${i+1}. ${escapeHtml(r.name)}</b></td><td>${r.played}</td><td>${r.votePoints}</td>
      <td>${r.green}</td><td>${r.yellow}</td><td>${r.red}</td><td>−${r.malus}</td>
      <td class="storico-season-net"><b>${r.net}</b></td><td>${r.voted}/${r.played}</td>
    </tr>`).join('');
    const seasonMobile=seasonRows.map((r,i)=>`<article class="storico-mobile-card storico-season-card">
      <div class="storico-mobile-head"><b>${i+1}. ${escapeHtml(r.name)}</b>${isAdmin()?`<span class="storico-mobile-badge is-voted">${r.voted}/${r.played} voti</span>`:''}</div>
      <div class="storico-mobile-primary"><div><small>Punti voto</small><strong>${r.votePoints}</strong></div><div><small>Malus</small><strong>−${r.malus}</strong></div><div><small>Netto stagione</small><strong>${r.net}</strong></div></div>
      <div class="storico-mobile-cards"><span>Giornate ${r.played}</span><span>🟩 ${r.green}</span><span>🟨 ${r.yellow}</span><span>🟥 ${r.red}</span></div>
    </article>`).join('');
    const seasonRoot=document.createElement('div');
    seasonRoot.className='card storico-season-summary';
    seasonRoot.innerHTML=`<div class="storico-season-head"><div><span class="eyebrow">STAGIONE</span><h3>📈 Riepilogo totale stagione</h3><p class="muted">Totale delle giornate in cui ogni player è stato effettivamente schierato.</p></div></div>
      ${seasonRows.length?`<div class="storico-table-wrap"><table class="storico-table storico-season-table"><thead><tr><th>Player</th><th>Giornate</th><th>Punti voto</th><th>🟩</th><th>🟨</th><th>🟥</th><th>Malus</th><th>Netto stagione</th>${isAdmin()?'<th>Voti</th>':''}</tr></thead><tbody>${seasonBody}</tbody></table></div><div class="storico-mobile-list" aria-label="Riepilogo stagione mobile">${seasonMobile}</div>`:`<p class="muted">Nessun dato stagionale disponibile.</p>`}`;
    box.appendChild(seasonRoot);
  }catch(e){
    console.error('Classifiche Squadra:',e);
    box.innerHTML='<div class="card"><p class="muted">Impossibile caricare lo Classifiche Squadra.</p></div>';
  }
}

function renderMatch(){
  if(!currentMatch){
    $('#matchTitle').textContent='Nessuna partita caricata'; $('#rosterList').innerHTML='<p class="muted">L’Admin deve inserire una partita nel calendario.</p>'; $('#votingCard')?.classList.add('hidden'); $('#matchStatsCard')?.classList.add('hidden'); $('#saveMatchStatsBtn')?.closest('.modal-actions')?.classList.add('hidden'); $('#matchStatsMsg')?.classList.add('hidden'); return;
  }
  // Il render del tabellino e' sincrono. Il caricamento Firestore avviene
  // esplicitamente dopo che la sessione Auth e' pronta, senza partire dal timer.
  renderMatchStats();
  const home=currentMatch.homeTeam||leagueTeam(), away=currentMatch.awayTeam||currentMatch.opponent||'Avversario';
  const title=`${home} vs ${away}`;
  $('#matchTitle').textContent=title; const mh=$('#match h2'); if(mh) mh.textContent=title;
  const d=parseDateTime(currentMatch); const meta=$('#match .match-meta'); if(meta) meta.innerHTML=`<span>Giornata ${escapeHtml(currentMatch.day||currentMatch.giornata||'')}</span><span>${formatDateTime(d)}</span>`;
  const dt=$('#match h3'); if(dt) dt.textContent=`Distinta ${escapeHtml(leagueTeam())}`;
  const box=$('#rosterList'), locked=isLineupLocked(), me=currentPlayer();
  box.innerHTML=players.map(p=>{
    const checked=lineup.includes(p.id), mine=me?.id===p.id;
    return `<label class="check ${locked||!isAdmin()?'locked':''}"><input type="checkbox" data-player="${escapeHtml(p.id)}" ${checked?'checked':''} ${(locked||!isAdmin())?'disabled':''}><span>${escapeHtml(playerName(p))}</span>${mine?'<small class="sub">Tu</small>':''}</label>`;
  }).join('');
  const lockBtn=$('#lockBtn');
  if(isAdmin()){
    if(String(currentMatch.status||'')==='finished'){
      lockBtn.style.display='none';
    }else{
      lockBtn.style.display='';
      if(matchHasStarted()) lockBtn.textContent=currentMatch.adminOverrideOpen?'🔒 Chiudi modifica eccezionale':'🔓 Sblocca distinta (eccezione Admin)';
      else lockBtn.textContent=currentMatch.lineupLocked?'🔓 Sblocca distinta':'🔒 Blocca distinta';
    }
  }else lockBtn.style.display='none';
  const status=$('#matchLockStatus');
  if(status){
    if(String(currentMatch.status||'')==='finished'){
      const deadline=votingDeadlineDate(currentMatch);
      status.textContent='🔒 Distinta definitivamente bloccata. ' + (deadline ? `⏱️ Votazione disponibile fino al ${formatDateTime(deadline)}.` : '');
    } else if(matchHasStarted()){
      status.textContent=(currentMatch.adminOverrideOpen?'⚠️ Sblocco eccezionale Admin attivo. ':'🔒 Distinta bloccata automaticamente all’inizio della partita.');
    } else status.textContent='🕒 Distinta modificabile fino all’inizio della partita.';
  }
  const canVote=isPlayer()&&votingWindowOpen(currentMatch)&&currentPlayerInLineup();
  if(canVote){ $('#votingCard').classList.remove('hidden'); populateVotes(); } else $('#votingCard').classList.add('hidden');
  const timer=$('#voteTimer');
  if(timer){
    if(isPlayer() && votingWindowOpen(currentMatch)) { timer.textContent=`⏱️ Tempo per votare: ${formatCountdown(votingRemainingMs(currentMatch))}`; timer.className='pill open'; }
    else if(isPlayer() && matchHasStarted()) { timer.textContent=currentMatch.votingClosed===true ? '🔒 Votazioni chiuse dall’Admin' : '⏱️ Finestra di voto scaduta'; timer.className='pill closed'; }
    else timer.textContent='⏱️ Il voto sarà disponibile dopo l’inizio della partita';
  }

  const adminVoteCard=$('#adminVotingCard');
  if(adminVoteCard){
    const showAdmin = isAdmin() && String(currentMatch.status||'')==='finished';
    adminVoteCard.classList.toggle('hidden', !showAdmin);
    adminVoteCard.classList.toggle('admin-only', false);
    const at=$('#adminVoteTimer');
    if(at){
      at.textContent = showAdmin && votingWindowOpen(currentMatch) ? `⏱️ Tempo residuo: ${formatCountdown(votingRemainingMs(currentMatch))}` : (currentMatch.votingClosed===true ? '🔒 Votazioni chiuse dall’Admin' : '🔒 Finestra di voto terminata');
      at.className = showAdmin && votingWindowOpen(currentMatch) ? 'pill open' : 'pill closed';
    }
    const cb=$('#closeVotingBtn');
    if(cb){ const canClose=showAdmin && votingWindowOpen(currentMatch); cb.disabled=!canClose; cb.textContent=currentMatch.votingClosed===true ? '🔒 Votazioni chiuse' : '🔒 Chiudi votazioni'; }
    const msg=$('#adminVoteMsg');
    if(msg) msg.textContent=currentMatch.votingClosed===true ? '✅ La finestra di voto è stata chiusa.' : '';
  }
  // A-06: updateProgress non viene più richiamata dal render del tabellino.
  // Il render gira ogni secondo per il timer e non deve generare una query
  // Firestore ad ogni tick.
}

$('#rosterList')?.addEventListener('change',async e=>{
  if(!isAdmin()||!e.target.matches('input')||isLineupLocked()) return;
  const id=e.target.dataset.player;
  if(e.target.checked&&!lineup.includes(id)) lineup.push(id);
  if(!e.target.checked) lineup=lineup.filter(x=>x!==id);
  try{ await db.collection('matches').doc(currentMatch.id).update({lineup}); currentMatch.lineup=[...lineup]; renderMatch(); }
  catch(err){ console.error(err); alert('Impossibile aggiornare la distinta.'); }
});
$('#lockBtn')?.addEventListener('click',async()=>{
  if(!isAdmin()||!currentMatch) return;
  if(String(currentMatch.status||'')==='finished') return;
  if(matchHasStarted() && currentMatch.adminOverrideOpen!==true){
    const ok=confirm("⚠️ ATTENZIONE\n\nLa partita è già iniziata. Sbloccare la distinta è un'operazione eccezionale e consente di modificarla dopo l'inizio della partita.\n\nVuoi procedere?");
    if(!ok) return;
  }
  const next=matchHasStarted()?!currentMatch.adminOverrideOpen:!currentMatch.lineupLocked;
  const data=matchHasStarted()?{adminOverrideOpen:next}:{lineupLocked:next};
  try{ await db.collection('matches').doc(currentMatch.id).update(data); Object.assign(currentMatch,data); renderMatch(); }
  catch(e){ console.error(e); alert('Firebase ha rifiutato la modifica della distinta.'); }
});
async function loadOwnVoteState(matchId=currentMatch?.id){
  localVoted=false;
  localVoteRanking=[];
  localVoteMatchId=matchId || null;
  if(!isPlayer()||!matchId) return;
  try{
    const snap=await db.collection('matches').doc(matchId).collection('votes').doc(uid()).get();
    if(!snap.exists) return;
    const data=snap.data()||{};
    const ranking=Array.isArray(data.ranking) ? data.ranking.map(String) : [];
    localVoted=true;
    localVoteRanking = ranking.length===3 && new Set(ranking).size===3 ? ranking : [];
  }catch(e){
    console.error('Caricamento stato voto personale:',e);
  }
}
function playerHasMatchPresence(playerId){
  const st=currentMatchStats?.[playerId];
  return !!st && (st.appearance===1 || st.appearance===true);
}
function populateVotes(){
  const me=currentPlayer(), eligible=players.filter(p=>lineup.includes(p.id)&&playerHasMatchPresence(p.id)&&p.id!==me?.id);

  // Il timer aggiorna la schermata ogni secondo. Prima di ricostruire i
  // menu salviamo quindi le selezioni correnti, altrimenti il loro valore
  // verrebbe azzerato ad ogni aggiornamento.
  const selected={};
  [1,2,3].forEach(n=>{
    const current=$('#vote'+n);
    if(current) selected[n]=current.value;
  });

  [1,2,3].forEach(n=>{
    const s=$('#vote'+n);
    if(!s) return;
    s.innerHTML='<option value="">Seleziona...</option>'+eligible.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(playerName(p))}</option>`).join('');
    const persisted=(localVoted && localVoteMatchId===currentMatch?.id) ? localVoteRanking[n-1] : '';
    const wanted=persisted || selected[n] || '';
    if(wanted && eligible.some(p=>p.id===wanted)) s.value=wanted;
    s.disabled=localVoted;
  });
  $('#submitVote').disabled=localVoted || eligible.length<3;
  if(localVoted) $('#voteMsg').textContent='✅ Voto già registrato per questo account.';
  else if(eligible.length<3) $('#voteMsg').textContent='⚠️ Servono almeno 3 giocatori con Presenza registrata per poter votare.';
  else $('#voteMsg').textContent='';
}
$('#closeVotingBtn')?.addEventListener('click',async()=>{
  if(!isAdmin()||!currentMatch||String(currentMatch.status||'')!=='finished'||!votingWindowOpen(currentMatch)) return;
  const ok=confirm('⚠️ CHIUDI VOTAZIONI\n\nLa finestra di voto verrà chiusa immediatamente.\nI Player non potranno più votare per questa partita.\nIl tabellino verrà protetto contestualmente alla chiusura delle votazioni.\n\nVuoi procedere?');
  if(!ok) return;
  const btn=$('#closeVotingBtn'); if(btn){btn.disabled=true;btn.textContent='⏳ Chiusura...';}
  try{
    const data={votingClosed:true,votingClosedAt:firebase.firestore.FieldValue.serverTimestamp(),updatedAt:firebase.firestore.FieldValue.serverTimestamp()};
    await db.collection('matches').doc(currentMatch.id).update(data);
    if(currentMatch.tabellinoFinalizzato!==true){
      await db.collection('matches').doc(currentMatch.id).update({tabellinoFinalizzato:true,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    }
    Object.assign(currentMatch,{votingClosed:true,tabellinoFinalizzato:true});
    renderMatch();
    renderDashboard();
  }catch(e){
    console.error('Chiusura anticipata votazioni:',e);
    alert(e.code==='permission-denied' ? '❌ Firebase ha rifiutato la chiusura delle votazioni. Verifica le Rules.' : '❌ Impossibile chiudere le votazioni.');
    if(btn){btn.disabled=false;btn.textContent='🔒 Chiudi votazioni';}
  }
});

$('#submitVote')?.addEventListener('click',async()=>{
  if(!isPlayer()||!currentMatch||!votingWindowOpen(currentMatch)||!currentPlayerInLineup()||localVoted) return;
  const ranking=[1,2,3].map(n=>$('#vote'+n).value), me=currentPlayer();
  if(ranking.some(x=>!x)||new Set(ranking).size!==3) return alert('Seleziona tre giocatori diversi.');
  if(ranking.some(x=>!lineup.includes(x))) return alert('Puoi votare solo giocatori presenti in distinta.');
  if(ranking.some(x=>!playerHasMatchPresence(x))) return alert('Puoi votare solo giocatori con Presenza registrata nel tabellino.');
  if(ranking.includes(me?.id)) return alert('Non puoi votare te stesso.');
  try{
    const matchRef=db.collection('matches').doc(currentMatch.id);
    const voteRef=matchRef.collection('votes').doc(uid());
    const resultRefs=ranking.map(id=>matchRef.collection('publicResults').doc(id));

    // Un'unica transazione: crea il voto segreto e aggiorna i tre risultati
    // pubblici. Le Security Rules verificano che gli incrementi corrispondano
    // esattamente al voto appena creato.
    await db.runTransaction(async tx=>{
      const snaps=await Promise.all(resultRefs.map(ref=>tx.get(ref)));
      snaps.forEach((snap,i)=>{
        const playerId=ranking[i];
        const old=snap.exists?snap.data():{points:0,first:0,second:0,third:0,votes:0,malus:0,net:0};
        const inc={points:3-i,first:i===0?1:0,second:i===1?1:0,third:i===2?1:0,votes:1};
        // Il voto aggiorna soltanto i punti ricevuti. Malus e netto devono
        // sopravvivere all'aggiornamento e il netto va sempre ricalcolato.
        // Se il documento proviene da una versione precedente, il malus
        // mancante viene considerato 0 e verrà poi riallineato dall'Admin.
        const points=(old.points||0)+inc.points;
        const malus=statNum(old.malus);
        tx.set(resultRefs[i],{
          points,
          first:(old.first||0)+inc.first,
          second:(old.second||0)+inc.second,
          third:(old.third||0)+inc.third,
          votes:(old.votes||0)+inc.votes,
          malus,
          net:points-malus
        });
      });
      tx.set(voteRef,{ranking});
    });

    localVoted=true;
    localVoteRanking=[...ranking];
    localVoteMatchId=currentMatch.id;
    populateVotes();
    renderMatch();
    alert('✅ Voto registrato. Grazie!');
  }
  catch(e){
    console.error('Errore registrazione voto:', e, {
      uid: uid(),
      playerId: window.currentUserData?.playerId,
      matchId: currentMatch?.id,
      matchStatus: currentMatch?.status,
      scheduledStart: currentMatch?.scheduledStart?.toDate ? currentMatch.scheduledStart.toDate().toISOString() : currentMatch?.scheduledStart,
      lineup: currentMatch?.lineup
    });
    if(e.code==='permission-denied'){
      alert('❌ Firebase ha rifiutato il voto. Controlla che il profilo Player abbia il campo playerId corretto e che quel giocatore sia nella distinta.');
    }else{
      alert(`❌ Impossibile registrare il voto.
${e.code||''} ${e.message||''}`.trim());
    }
  }
});

async function syncPublicResultsForAdmin(){
  if(!isAdmin()) return;
  try{
    for(const m of matches){
      const [votesSnap, statsSnap]=await Promise.all([
        db.collection('matches').doc(m.id).collection('votes').get(),
        db.collection('matches').doc(m.id).collection('stats').get()
      ]);
      const presentIds=new Set();
      statsSnap.forEach(doc=>{
        const st=doc.data()||{};
        if(st.appearance===1 || st.appearance===true) presentIds.add(doc.id);
      });
      const totals={};
      votesSnap.forEach(doc=>{
        (doc.data().ranking||[]).forEach((id,i)=>{
          if(!presentIds.has(id)) return;
          if(!totals[id]) totals[id]={points:0,first:0,second:0,third:0,votes:0,malus:0,net:0};
          totals[id].points+=3-i;
          totals[id].votes++;
          totals[id][['first','second','third'][i]]++;
        });
      });
      // Pubblica anche il malus, così tutti possono vedere punti voto e netto.
      statsSnap.forEach(doc=>{
        if(!presentIds.has(doc.id)) return;
        const st=doc.data()||{};
        const green=statNum(st.green);
        const yellow=statNum(st.yellow);
        const red=statNum(st.red);
        const malus=green * 1 + yellow * 3 + red*10;
        if(!totals[doc.id]) totals[doc.id]={points:0,first:0,second:0,third:0,votes:0,malus:0,net:0};
        totals[doc.id].malus=malus;
        totals[doc.id].net=statNum(totals[doc.id].points)-malus;
      });
      // Ogni giocatore schierato deve avere un aggregato completo, anche se
      // non ha ricevuto voti e anche se il vecchio publicResults non contiene
      // ancora i campi malus/net.
      presentIds.forEach(id=>{
        if(!totals[id]) totals[id]={points:0,first:0,second:0,third:0,votes:0,malus:0,net:0};
        totals[id].points=statNum(totals[id].points);
        totals[id].malus=statNum(totals[id].malus);
        totals[id].net=totals[id].points-totals[id].malus;
      });
      const resultSnap=await db.collection('matches').doc(m.id).collection('publicResults').get();
      const batch=db.batch();
      let writes=0;
      Object.entries(totals).forEach(([id,t])=>{
        batch.set(db.collection('matches').doc(m.id).collection('publicResults').doc(id),t);
        writes++;
      });
      resultSnap.docs.forEach(d=>{
        if(!totals[d.id]){ batch.delete(d.ref); writes++; }
      });
      if(writes) await batch.commit();
    }
  }catch(e){ console.error('Sincronizzazione risultati pubblici:',e); }
}

function renderPlayers(){
  $('#playersTable').innerHTML=players.map(p=>{
    const name=playerName(p), parts=name.trim().split(/\s+/).filter(Boolean);
    const initials=(parts[0]?.[0]||'')+(parts.length>1?(parts[parts.length-1]?.[0]||''):'');
    const inLineup=lineup.includes(p.id);
    return `<div class="rank"><span class="pos">${escapeHtml(initials.toUpperCase())}</span><div><b>${escapeHtml(name)}</b><span class="sub roster-status ${inLineup?'in-lineup':''}">${inLineup?'In distinta':'Fuori distinta'}</span></div></div>`;
  }).join('')||'<p class="muted">Nessun giocatore.</p>';
  renderSeasonStats();
}
async function updateProgress(){
  if(!currentMatch)return; const total=lineup.length;
  if(!isAdmin()){
    $('#voteProgress').style.width='0%';
    $('#voteCount').textContent=`${total} giocatori in distinta`;
    return;
  }
  try{
    const snap=await db.collection('matches').doc(currentMatch.id).collection('votes').get();
    const votedIds=new Set(snap.docs.map(d=>String(d.id)));
    const rosterPlayers=players.filter(p=>lineup.includes(p.id));
    const voted=rosterPlayers.filter(p=>p.userId && votedIds.has(String(p.userId))).length;
    const label=`${voted} / ${total} giocatori hanno votato`;
    $('#voteProgress').style.width=(total?Math.min(100,voted/total*100):0)+'%';
    $('#voteCount').textContent=label;
    const adminCount=$('#adminVoteCount');
    if(adminCount) adminCount.textContent=label;

    const participation=$('#adminVoteParticipation');
    if(participation){
      if(!rosterPlayers.length){
        participation.innerHTML='<p class="muted">Nessun giocatore presente in distinta.</p>';
      }else{
        const rows=rosterPlayers.map(p=>{
          const hasVoted=!!p.userId && votedIds.has(String(p.userId));
          return `<div class="vote-participation-row ${hasVoted?'has-voted':'not-voted'}"><span class="vote-participation-name">${escapeHtml(playerName(p))}</span><span class="vote-participation-status">${hasVoted?'✓ Ha votato':'○ Non ha votato'}</span></div>`;
        }).join('');
        participation.innerHTML=`<div class="vote-participation-title">Partecipazione dei giocatori</div>${rows}`;
      }
    }
  }catch(err){
    console.error('Aggiornamento partecipazione voti:',err);
    const participation=$('#adminVoteParticipation');
    if(participation) participation.innerHTML='<p class="muted">Impossibile caricare la partecipazione al voto.</p>';
  }
}

// ---------- Registrazioni e rosa Admin ----------
async function loadPendingRegistrations(){
  const box=$('#pendingRegistrations'); if(!box||!isAdmin()) return;
  try{
    const snap=await db.collection('users').where('leagueId','==',leagueId()).get();
    const pending=snap.docs.map(d=>({id:d.id,...d.data()})).filter(u=>u.role==='player' && u.active===false && u.registrationStatus==='pending');
    if(!pending.length){box.innerHTML='<p class="muted">Nessuna registrazione in attesa.</p>';return;}
    box.innerHTML=pending.map(u=>{const name=[u.nome,u.cognome].filter(Boolean).join(' ')||'Nome non indicato'; const parts=name.trim().split(/\s+/); const initials=((parts[0]?.[0]||'')+(parts.length>1?(parts[parts.length-1]?.[0]||''):'')).toUpperCase(); return `<div class="admin-user-row pending-user"><span class="admin-avatar">${escapeHtml(initials)}</span><div class="admin-user-main"><b>${escapeHtml(name)}</b><span class="sub">${escapeHtml(u.email||'Email non disponibile')}</span></div><button class="primary small-action" data-associate-user="${escapeHtml(u.id)}">Associa</button></div>`;}).join('');
    box.querySelectorAll('[data-associate-user]').forEach(btn=>btn.addEventListener('click',()=>associateRegistration(btn.dataset.associateUser)));
  }catch(e){console.error('Registrazioni in attesa:',e);box.innerHTML='<p class="muted">Impossibile caricare le registrazioni.</p>';}
}
async function associateRegistration(userId){
  if(!isAdmin()) return;
  const userSnap=await db.collection('users').doc(userId).get();
  if(!userSnap.exists){alert('Registrazione non trovata.');return;}
  const u=userSnap.data()||{};
  const available=players.filter(p=>!p.userId && !p.associatedUid);
  if(!available.length){alert('Nessun giocatore libero nella rosa. Aggiungi prima il giocatore.');return;}
  const labels=available.map((p,i)=>`${i+1}. ${playerName(p)}`).join('\n');
  const answer=prompt(`Associa ${[u.nome,u.cognome].filter(Boolean).join(' ')} (${u.email||'email non disponibile'}) a quale giocatore?\n\n${labels}\n\nInserisci il numero:`);
  if(answer===null)return;
  const idx=Number(answer)-1;
  if(!Number.isInteger(idx)||idx<0||idx>=available.length){alert('Scelta non valida.');return;}
  const p=available[idx];
  if(!confirm(`Confermi l'associazione di ${u.email||'questa utenza'} a ${playerName(p)}?`)) return;
  try{
    const batch=db.batch();
    batch.update(db.collection('users').doc(userId),{playerId:p.id,active:true,registrationStatus:'approved',associatedAt:firebase.firestore.FieldValue.serverTimestamp()});
    batch.update(db.collection('players').doc(p.id),{userId:userId});
    await batch.commit();
    await refresh();
    alert(`✅ Utenza associata a ${playerName(p)}.`);
  }catch(e){console.error('Associazione:',e);alert('❌ Impossibile completare l’associazione.');}
}
async function addPlayerFromAdmin(e){
  e.preventDefault(); if(!isAdmin())return;
  const nome=$('#addPlayerNome').value.trim(), cognome=$('#addPlayerCognome').value.trim();
  if(!nome||!cognome)return;
  try{
    await db.collection('players').add({nome,cognome,displayName:`${nome} ${cognome}`.trim(),leagueId:leagueId(),active:true,userId:null,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
    $('#addPlayerForm').reset(); await refresh(); alert(`✅ ${nome} ${cognome} aggiunto alla rosa.`);
  }catch(e){console.error('Aggiunta giocatore:',e);alert('❌ Impossibile aggiungere il giocatore.');}
}
async function renderAdminPlayers(){
  const box=$('#adminPlayersList'); if(!box||!isAdmin())return;
  try{
    const associated=players.filter(p=>p.userId);
    const userEntries=await Promise.all(associated.map(async p=>{
      try{
        const snap=await db.collection('users').doc(p.userId).get();
        return [p.userId, snap.exists ? snap.data() : {}];
      }catch(e){
        console.error('Lettura utente associato:',e);
        return [p.userId, {}];
      }
    }));
    const userMap=Object.fromEntries(userEntries);
    box.innerHTML=players.map(p=>{
      const u=p.userId ? (userMap[p.userId]||{}) : null;
      const email=u?.email||'Email non disponibile';
      const action=p.userId
        ? `<button class="small-btn" data-change-email="${escapeHtml(p.userId)}">✉️ Modifica mail utente</button>`
        : '';
      const name=playerName(p); const parts=String(name).trim().split(/\s+/); const initials=((parts[0]?.[0]||'')+(parts.length>1?(parts[parts.length-1]?.[0]||''):'')).toUpperCase(); const status=p.userId?`<span class="admin-status associated">● Associato</span><span class="admin-email">${escapeHtml(email)}</span>`:`<span class="admin-status pending">● Non associato</span>`; return `<div class="admin-user-row"><span class="admin-avatar">${escapeHtml(initials)}</span><div class="admin-user-main"><b>${escapeHtml(name)}</b><span class="sub admin-account">${status}</span></div>${action?`<div class="admin-user-action">${action}</div>`:''}</div>`;
    }).join('')||'<p class="muted">Nessun giocatore.</p>';
    box.querySelectorAll('[data-change-email]').forEach(btn=>btn.addEventListener('click',()=>changePlayerEmail(btn.dataset.changeEmail)));
  }catch(e){
    console.error('Render gestione rosa:',e);
    box.innerHTML='<p class="muted">Impossibile caricare gli account associati.</p>';
  }
}

async function renderAdminManagement(){
  const box=$('#adminManagementList');
  if(!box || !isSuperAdmin()) return;
  try{
    const snap=await db.collection('users').get();
    const users=snap.docs.map(d=>({id:d.id,...d.data()}))
      .filter(u=>u.active===true && u.id!==uid() && (u.role==='admin'||u.role==='player'))
      .sort((a,b)=>String(a.cognome||a.nome||'').localeCompare(String(b.cognome||b.nome||''),'it'));
    if(!users.length){ box.innerHTML='<p class="muted">Nessun altro account attivo da gestire.</p>'; return; }
    box.innerHTML=users.map(u=>{
      const name=[u.nome,u.cognome].filter(Boolean).join(' ')||u.email||'Utente';
      const isAdm=u.role==='admin';
      const label=isAdm?'🛡️ Admin':'👤 Player';
      const action=isAdm
        ? `<button class="small-btn" data-demote-admin="${escapeHtml(u.id)}">Rimuovi ruolo Admin</button>`
        : `<button class="small-btn" data-promote-admin="${escapeHtml(u.id)}">Promuovi ad Admin</button>`;
      return `<div class="admin-user-row"><span class="admin-avatar">${escapeHtml((name.match(/\b\p{L}/gu)||[]).slice(0,2).join('').toUpperCase())}</span><div class="admin-user-main"><b>${escapeHtml(name)}</b><span class="sub admin-account">${label} · ${escapeHtml(u.email||'email non disponibile')}</span></div><div class="admin-user-action">${action}</div></div>`;
    }).join('');
    box.querySelectorAll('[data-promote-admin]').forEach(btn=>btn.addEventListener('click',()=>setAdminRole(btn.dataset.promoteAdmin,'admin')));
    box.querySelectorAll('[data-demote-admin]').forEach(btn=>btn.addEventListener('click',()=>setAdminRole(btn.dataset.demoteAdmin,'player')));
  }catch(e){ console.error('Gestione Admin:',e); box.innerHTML='<p class="muted">Impossibile caricare gli account amministrabili.</p>'; }
}
async function setAdminRole(userId,nextRole){
  if(!isSuperAdmin()||!userId||!['admin','player'].includes(nextRole)) return;
  try{
    const ref=db.collection('users').doc(userId); const snap=await ref.get();
    if(!snap.exists){ alert('Utente non trovato.'); return; }
    const u=snap.data()||{};
    if(u.role==='superAdmin'){ alert('Il Super Admin non può essere modificato da questa funzione.'); return; }
    const name=[u.nome,u.cognome].filter(Boolean).join(' ')||u.email||'questo utente';
    const text=nextRole==='admin'?`Confermi di promuovere ${name} ad Admin?`:`Confermi di rimuovere il ruolo Admin a ${name}?`;
    if(!confirm(text)) return;
    await ref.update({role:nextRole});
    await renderAdminManagement();
    alert(nextRole==='admin'?'✅ Utente promosso ad Admin.':'✅ Ruolo Admin rimosso.');
  }catch(e){ console.error('Cambio ruolo Admin:',e); alert('❌ Impossibile modificare il ruolo.'); }
}

async function changePlayerEmail(userId){
  if(!isAdmin()||!userId)return;
  const player=players.find(p=>p.userId===userId);
  if(!player){alert('Giocatore non trovato.');return;}
  let currentEmail='';
  try{
    const snap=await db.collection('users').doc(userId).get();
    currentEmail=snap.exists?(snap.data().email||''):'';
  }catch(e){console.error(e);}
  const newEmail=prompt(`Modifica email utente di ${playerName(player)}.\n\nEmail attuale: ${currentEmail||'non disponibile'}\n\nInserisci la nuova email:`, currentEmail||'');
  if(newEmail===null)return;
  const normalized=newEmail.trim().toLowerCase();
  if(!normalized){alert('Inserisci un indirizzo email.');return;}
  if(normalized===String(currentEmail).trim().toLowerCase()){alert('La nuova email coincide con quella attuale.');return;}
  if(!confirm(`Confermi la modifica dell'email di ${playerName(player)}?\n\nNuova email: ${normalized}\n\nIl Player dovrà verificare nuovamente il nuovo indirizzo.`))return;
  try{
    const fn=firebase.app().functions('europe-west8').httpsCallable('updatePlayerEmail');
    const result=await fn({uid:userId,newEmail:normalized});
    if(result?.data?.ok){
      await refresh();
      alert(`✅ Email aggiornata per ${playerName(player)}.\n\nNuovo indirizzo: ${normalized}\n\nIl Player dovrà accedere con la nuova email e completare nuovamente la verifica.`);
    }else{
      alert('❌ Modifica email non completata.');
    }
  }catch(e){
    console.error('Modifica email utente:',e);
    const msg=e?.message||'';
    if(e?.code==='functions/already-exists') alert('❌ Questa email è già associata a un altro account Firebase.');
    else if(e?.code==='functions/permission-denied') alert('❌ Operazione non autorizzata.');
    else if(e?.code==='functions/not-found') alert('❌ Account Firebase non trovato.');
    else alert(`❌ Impossibile modificare l'email.\n\n${msg||'Controlla che le Cloud Functions siano state pubblicate.'}`);
  }
}

document.querySelector('#addPlayerForm')?.addEventListener('submit',addPlayerFromAdmin);
document.querySelector('#playerVisibilityForm')?.addEventListener('submit',savePlayerVisibility);

// ---------- Calendario Admin ----------
function renderCalendar(){
  const box=$('#calendarList'); if(!box) return;
  if(!isAdmin()){box.innerHTML='<p class="muted">Solo gli Admin possono gestire il calendario.</p>';return;}
  const grouped={Andata:[],Ritorno:[]};
  matches.forEach(m=>{const phase=String(m.fase||'').toLowerCase()==='ritorno'?'Ritorno':'Andata';grouped[phase].push(m);});
  const section=(name,arr)=>`<div class="calendar-group"><h3>${name}</h3>${arr.sort((a,b)=>(Number(a.giornata||a.day)||0)-(Number(b.giornata||b.day)||0)).map(m=>{
    const d=parseDateTime(m), title=`${m.homeTeam||leagueTeam()} vs ${m.awayTeam||m.opponent||''}`;
    return `<div class="calendar-row"><div><b>G${escapeHtml(m.giornata||m.day||'')}</b><span>${escapeHtml(title)}</span><small>${formatDateTime(d)}</small></div><span class="pill ${statusClass(m.status)}">${statusLabel(m.status)}</span><div class="calendar-actions"><button class="small-btn stats-match" data-id="${escapeHtml(m.id)}">📊 Tabellino</button><button class="small-btn edit-match" data-id="${escapeHtml(m.id)}">✏️ Modifica</button><button class="small-btn danger delete-match" data-id="${escapeHtml(m.id)}">🗑️ Elimina</button></div></div>`;
  }).join('')||'<p class="muted">Nessuna partita.</p>'}</div>`;
  box.innerHTML=section('Andata',grouped.Andata)+section('Ritorno',grouped.Ritorno);
}
function setCalendarMessage(text,good=false){const el=$('#calendarMsg');if(el){el.textContent=text;el.className=good?'success':'muted';}}
function openMatchEditor(match=null){
  if(!isAdmin())return;
  $('#matchEditId').value=match?.id||'';
  $('#matchEditRound').value=match?.giornata||match?.day||'';
  $('#matchEditPhase').value=String(match?.fase||'Andata').toLowerCase()==='ritorno'?'Ritorno':'Andata';
  const d=parseDateTime(match); $('#matchEditDate').value=d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:'';
  $('#matchEditTime').value=d?`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`:'';
  $('#matchEditHome').value=match?.homeTeam||leagueTeam(); $('#matchEditAway').value=match?.awayTeam||'';
  $('#matchEditStatus').value=match?.status||'scheduled';
  const lockedByTime=!!match && String(match.status||'scheduled')!=='postponed' && matchHasStarted(match);
  setMatchEditorTimingLock(lockedByTime);
  $('#matchModal').classList.remove('hidden');
}
function setMatchEditorTimingLock(locked){
  ['#matchEditRound','#matchEditPhase','#matchEditDate','#matchEditTime','#matchEditHome','#matchEditAway'].forEach(sel=>{const el=$(sel); if(el) el.disabled=!!locked;});
}
function closeMatchEditor(){ $('#matchModal').classList.add('hidden'); }
function buildScheduledStart(date,time){ return new Date(`${date}T${time}:00`); }
async function saveMatchEditor(e){
  e.preventDefault(); if(!isAdmin())return;
  const id=$('#matchEditId').value;
  const old=id?matches.find(m=>m.id===id):null;
  const selectedStatus=$('#matchEditStatus').value;
  const lockedByTime=!!old && String(old.status||'scheduled')!=='postponed' && matchHasStarted(old);

  // Una partita già iniziata non può essere trasformata in RINVIATA: il rinvio
  // deve essere deciso prima dell'orario di inizio.
  if(lockedByTime && selectedStatus==='postponed'){
    alert('⚠️ La partita è già iniziata. Non è più possibile impostarla come RINVIATA.');
    $('#matchEditStatus').value=old?.status||'scheduled';
    return;
  }

  const round=String($('#matchEditRound').value).trim();
  const phase=$('#matchEditPhase').value;
  const home=$('#matchEditHome').value.trim();
  const away=$('#matchEditAway').value.trim();
  const date=$('#matchEditDate').value;
  const time=$('#matchEditTime').value;
  if(!date||!time||!home||!away)return alert('Compila casa, trasferta, data e ora.');

  // Dopo l'inizio, quando la partita non è RINVIATA, data/ora/squadre/fase/giornata
  // restano quelle già registrate. Il timer è quindi la vera protezione.
  const effectiveDate=lockedByTime ? (parseDateTime(old)?`${parseDateTime(old).getFullYear()}-${String(parseDateTime(old).getMonth()+1).padStart(2,'0')}-${String(parseDateTime(old).getDate()).padStart(2,'0')}`:date) : date;
  const effectiveTime=lockedByTime ? (parseDateTime(old)?`${String(parseDateTime(old).getHours()).padStart(2,'0')}:${String(parseDateTime(old).getMinutes()).padStart(2,'0')}`:time) : time;
  const effectiveRound=lockedByTime ? String(old.giornata||old.day||round) : round;
  const effectivePhase=lockedByTime ? (String(old.fase||'Andata').toLowerCase()==='ritorno'?'Ritorno':'Andata') : phase;
  const effectiveHome=lockedByTime ? String(old.homeTeam||leagueTeam()) : home;
  const effectiveAway=lockedByTime ? String(old.awayTeam||old.opponent||'') : away;
  const scheduledStart=buildScheduledStart(effectiveDate,effectiveTime);
  const data={giornata:effectiveRound,day:effectiveRound,fase:effectivePhase,homeTeam:effectiveHome,awayTeam:effectiveAway,opponent:isLocalTeamName(effectiveHome)?effectiveAway:(isLocalTeamName(effectiveAway)?effectiveHome:effectiveAway),isHome:isLocalTeamName(effectiveHome),scheduledStart:firebase.firestore.Timestamp.fromDate(scheduledStart),date:formatDate(scheduledStart),time:effectiveTime,status:selectedStatus};

  if(selectedStatus==='finished') {
    if(!old || !old.finishedAt) data.finishedAt=firebase.firestore.FieldValue.serverTimestamp();
  } else if(id && String(old?.status||'')!=='finished') {
    data.finishedAt=firebase.firestore.FieldValue.delete();
  }

  // RINVIATA azzera completamente la distinta e la rende nuovamente preparabile.
  if(selectedStatus==='postponed'){
    data.lineup=[];
    data.lineupLocked=false;
    data.adminOverrideOpen=false;
  }

  try{
    if(id){
      await db.collection('matches').doc(id).update(data);
    }else{
      data.leagueId=leagueId(); data.lineup=[]; data.lineupLocked=false; data.adminOverrideOpen=false; data.calendarKey=calendarKey({fase:data.fase,giornata:data.giornata,casa:effectiveHome,trasferta:effectiveAway});
      await db.collection('matches').add(data);
    }
    closeMatchEditor(); setCalendarMessage('✅ Partita salvata.',true); await loadMatches(); renderCalendar(); renderMatch();
  }catch(err){console.error(err);alert(err.code==='permission-denied'?'❌ Firebase ha rifiutato la modifica. Dopo l’inizio restano bloccate data/ora e squadre, mentre lo stato resta gestibile secondo le regole della partita.':'❌ Impossibile salvare la partita.');}
}

async function deleteMatch(matchId){
  if(!isAdmin()||!matchId)return;
  const match=matches.find(m=>m.id===matchId);
  if(!match)return;
  const title=`${match.homeTeam||leagueTeam()} vs ${match.awayTeam||match.opponent||''}`;
  const ok=confirm(`⚠️ ATTENZIONE\n\nStai per eliminare definitivamente la partita:\n${title}\n\nVerranno eliminati anche voti, statistiche, riepilogo e risultati collegati.\n\nL'operazione non può essere annullata.\n\nVuoi procedere?`);
  if(!ok)return;
  try{
    const subcollections=['votes','stats','summary','publicResults'];
    for(const sub of subcollections){
      const snap=await db.collection('matches').doc(matchId).collection(sub).get();
      const docs=snap.docs;
      for(let i=0;i<docs.length;i+=450){
        const batch=db.batch();
        docs.slice(i,i+450).forEach(doc=>batch.delete(doc.ref));
        await batch.commit();
      }
    }
    await db.collection('matches').doc(matchId).delete();
    if(currentMatch?.id===matchId){currentMatch=null; lineup=[];}
    await loadMatches(); renderCalendar(); renderDashboard(); renderMatch();
    setCalendarMessage('✅ Partita eliminata.',true);
  }catch(err){console.error('Eliminazione partita:',err);alert(err.code==='permission-denied'?'❌ Firebase ha rifiutato l’eliminazione.':'❌ Impossibile eliminare la partita.');}
}

function excelSerialToDate(value){
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epoch = new Date(Date.UTC(1899,11,30));
    const d = new Date(epoch.getTime() + value * 86400000);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  }
  if (typeof value === 'string') {
    const text=value.trim();
    const m=text.match(/^(\d{1,2})[\\/.](\d{1,2})[\\/.](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if(m) return new Date(Number(m[3]),Number(m[2])-1,Number(m[1]),Number(m[4]||0),Number(m[5]||0),0);
  }
  return null;
}
function parseExcelRows(workbook){
  const rows=[]; let phase='Andata';
  workbook.SheetNames.forEach(name=>{
    const sheet=workbook.Sheets[name];
    const data=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:null});
    data.forEach(r=>{
      const first=String(r?.[0]??'').trim().toUpperCase();
      if(first==='ANDATA'){phase='Andata';return;}
      if(first==='RITORNO'){phase='Ritorno';return;}
      if(first==='GIORNATA')return;
      const giornata=String(r?.[0]??'').trim();
      const casa=String(r?.[1]??'').trim();
      const trasferta=String(r?.[2]??'').trim();
      const d=excelSerialToDate(r?.[3]);
      if(!/^\d+$/.test(giornata)||!casa||!trasferta||!d||Number.isNaN(d.getTime()))return;
      rows.push({fase:phase,giornata,casa,trasferta,date:d});
    });
  });
  return rows;
}
function localAndOpponent(row){
  // Manteniamo l'ordine reale della partita del calendario.
  // isHome indica invece se la squadra della lega è la squadra di casa.
  if(isLocalTeamName(row.casa)) return {isHome:true,home:row.casa,away:row.trasferta,opponent:row.trasferta};
  if(isLocalTeamName(row.trasferta)) return {isHome:false,home:row.casa,away:row.trasferta,opponent:row.casa};
  return {isHome:null,home:row.casa,away:row.trasferta,opponent:row.trasferta};
}
function renderImportPreview(rows){
  const box=$('#importPreview'); if(!box)return;
  const existing=new Map(matches.map(m=>[m.calendarKey,m]));
  calendarDraft=rows.map(r=>{
    const k=calendarKey(r), found=existing.get(k); const loc=localAndOpponent(r);
    let type=found?'MODIFICA':'NUOVA', warning='';
    if(loc.isHome===null) warning=`La squadra della lega "${leagueTeam()}" non è riconosciuta in questa partita`;
    return {...r,calendarKey:k,found,loc,type,warning};
  });
  box.innerHTML=calendarDraft.map(r=>`<div class="import-row"><div><b>${escapeHtml(r.fase)} G${escapeHtml(r.giornata)}</b><span>${escapeHtml(r.casa)} vs ${escapeHtml(r.trasferta)}</span><small>${formatDateTime(r.date)}</small></div><span class="import-badge ${r.type==='NUOVA'?'new':'change'}">${r.type}</span>${r.warning?`<span class="warning">⚠️ ${escapeHtml(r.warning)}</span>`:''}</div>`).join('')||'<p class="muted">Nessuna riga valida trovata.</p>';
  $('#importCommit').disabled=!calendarDraft.length||calendarDraft.some(x=>x.warning);
  $('#importPreviewCard').classList.remove('hidden');
}
async function handleExcel(file){
  if(!file||!isAdmin())return;
  setCalendarMessage(`📖 Lettura di ${file.name}...`);
  try{
    const buffer=await file.arrayBuffer();
    const wb=XLSX.read(buffer,{type:'array',cellDates:true});
    const rows=parseExcelRows(wb);
    if(!rows.length) throw new Error('Nessuna riga partita riconosciuta. Attese colonne: GIORNATA, CASA, TRASFERTA, DATA.');
    renderImportPreview(rows);
    setCalendarMessage(`✅ ${rows.length} partite trovate. Controlla l'anteprima prima di confermare.`);
  }catch(e){
    console.error('Import Excel:',e);
    setCalendarMessage(`❌ ${e.message||'File Excel non valido o struttura non riconosciuta.'}`);
  }
}
async function commitImport(){
  if(!isAdmin()||!calendarDraft.length)return;
  const existingMap=new Map(matches.map(m=>[m.calendarKey,m]));
  try{
    let created=0,updated=0;
    for(const r of calendarDraft){
      const loc=r.loc; const d=r.date; const data={calendarKey:r.calendarKey,leagueId:leagueId(),giornata:String(r.giornata),day:String(r.giornata),fase:r.fase,homeTeam:loc.home,awayTeam:loc.away,opponent:loc.opponent,isHome:loc.isHome,scheduledStart:firebase.firestore.Timestamp.fromDate(d),date:formatDate(d),time:`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`};
      const old=existingMap.get(r.calendarKey);
      if(old){
        const oldDate=parseDateTime(old); const changed=!oldDate||oldDate.getTime()!==d.getTime();
        if(changed&&matchHasStarted(old)) throw new Error(`La partita G${r.giornata} ${r.fase} è già iniziata e non può essere rischedulata tramite import.`);
        await db.collection('matches').doc(old.id).update(data); updated++;
      }else{
        await db.collection('matches').add({...data,lineup:[],lineupLocked:false,adminOverrideOpen:false,status:'scheduled'}); created++;
      }
    }
    $('#importPreviewCard').classList.add('hidden'); $('#excelInput').value=''; await loadMatches(); renderCalendar(); renderMatch(); setCalendarMessage(`✅ Importazione completata: ${created} nuove, ${updated} aggiornate.`,true);
  }catch(e){console.error(e);alert(e.message.startsWith('La partita')?`❌ ${e.message}`:'❌ Importazione non completata. Nessuna garanzia di rollback automatico.');}
}

$('#playedMatchesList')?.addEventListener('click',e=>{
  const btn=e.target.closest('.played-match-summary');
  if(!btn) return;
  const card=btn.closest('.played-match-accordion');
  const body=card?.querySelector('.played-match-body');
  if(!card||!body) return;
  const open=card.classList.toggle('is-open');
  btn.setAttribute('aria-expanded',String(open));
  body.hidden=!open;
  if(open && card.dataset.loaded!=='1') loadPlayedMatchDetails(card.dataset.playedMatch,card);
});

$('#calendarList')?.addEventListener('click',async e=>{
  const statsBtn=e.target.closest('.stats-match');
  if(statsBtn&&isAdmin()){
    const m=matches.find(x=>x.id===statsBtn.dataset.id);
    if(m){
      // Aprendo il tabellino dal Calendario dobbiamo ricaricare esplicitamente
      // stats e riepilogo della partita selezionata, anche dopo logout/login.
      currentMatch=m;
      lineup=Array.isArray(m.lineup)?[...m.lineup]:[];
      localVoted=false;
      currentMatchStats={};
      currentMatchSummary={};
      matchDetailsFor=null;
      await loadCurrentMatchDetails(m.id);
      renderMatch();
      show('match');
    }
    return;
  }
  const deleteBtn=e.target.closest('.delete-match');
  if(deleteBtn&&isAdmin()){ deleteMatch(deleteBtn.dataset.id); return; }
  const b=e.target.closest('.edit-match'); if(b){const m=matches.find(x=>x.id===b.dataset.id);openMatchEditor(m);}
});
$('#matchEditStatus')?.addEventListener('change',e=>{
  const id=$('#matchEditId').value;
  const m=id?matches.find(x=>x.id===id):null;
  const lockedByTime=!!m && String(m.status||'scheduled')!=='postponed' && matchHasStarted(m);
  if(lockedByTime && e.target.value==='postponed'){
    e.target.value=m.status||'scheduled';
    alert("⚠️ Il rinvio deve essere impostato prima dell'orario di inizio della partita.");
    return;
  }
  setMatchEditorTimingLock(lockedByTime && e.target.value!=='postponed');
});
document.addEventListener('change',e=>{
  if(e.target.matches('.stat-appearance')){
    const row=e.target.closest('.stats-row[data-stat-player]');
    if(!row) return;
    matchStatsDraftDirty=true;
    const enabled=e.target.checked;
    row.querySelectorAll('.stat-goals,.stat-assists,.stat-green,.stat-yellow,.stat-red').forEach(input=>{ input.disabled=!enabled; });
    const note=row.querySelector('.stats-note');
    if(note) note.textContent=enabled?'Presenza registrata':'Non ancora registrato come presente';
  }
});
document.addEventListener('input',e=>{
  if(e.target.matches('.stat-goals,.stat-assists,.stat-green,.stat-yellow,.stat-red,#opponentScore')) matchStatsDraftDirty=true;
});

$('#saveMatchStatsBtn')?.addEventListener('click',saveMatchStats);
$('#finalizeMatchStatsBtn')?.addEventListener('click',finalizeMatchStats);
$('#exceptionalEditStatsBtn')?.addEventListener('click',openExceptionalStatsEdit);
$('#newMatchBtn')?.addEventListener('click',()=>openMatchEditor());
$('#cancelMatchEdit')?.addEventListener('click',closeMatchEditor); $('#closeMatchModal')?.addEventListener('click',closeMatchEditor);
$('#matchEditForm')?.addEventListener('submit',saveMatchEditor);
$('#excelInput')?.addEventListener('change',e=>handleExcel(e.target.files?.[0]));
$('#importCommit')?.addEventListener('click',commitImport);
$('#importCancel')?.addEventListener('click',()=>{$('#importPreviewCard').classList.add('hidden');calendarDraft=[];$('#excelInput').value='';});

function show(id,force=false){
  if(id==='admin'&&!isAdmin())return; if(id==='calendar'&&!isAdmin())return;
  if(!force && !playerCanSeeScreen(id))return;
  if(id==='dashboard'){
    // La Home deve sempre ricalcolare la propria partita principale.
    // Aprire un vecchio match dal Calendario non deve trascinarlo nella Home.
    selectHomeMatch();
  }
  $$('.screen').forEach(x=>x.classList.remove('active')); $('#'+id)?.classList.add('active');
  if(id==='ranking')renderRanking();
  if(id==='players')renderPlayers();
  if(id==='match'){
    renderMatch();
    if(isAdmin() && currentMatch?.id){
      void autoFinalizeTabellinoIfNeeded(currentMatch);
      updateProgress();
    }
    if(isPlayer() && currentMatch?.id){
      const matchId=currentMatch.id;
      loadOwnVoteState(matchId).then(()=>{
        if(currentMatch?.id===matchId) renderMatch();
      });
    }
  }
  if(id==='calendar')renderCalendar(); if(id==='storicoSquadra')renderStoricoSquadra();
  if(id==='played')renderPlayedMatches();
  if(id==='dashboard')renderDashboard();
}
$$('[data-screen]').forEach(b=>b.onclick=()=>show(b.dataset.screen));
$('#dashboardMatchCard')?.addEventListener('click',()=>{ if(currentMatch) show('match'); });
$('#dashboardMatchCard')?.addEventListener('keydown',e=>{ if((e.key==='Enter'||e.key===' ')&&currentMatch){e.preventDefault();show('match');} });
$$('.tab').forEach(t=>t.onclick=()=>{$$('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');renderRanking();});
let voteTimer=null;
let expiredVoteMatchHandled=null;
function updateVoteWindowUI(){
  if(!currentMatch) return;
  const open=votingWindowOpen(currentMatch);
  if(isAdmin() && String(currentMatch.status||'')==='finished') void autoFinalizeTabellinoIfNeeded(currentMatch);
  const started=matchHasStarted(currentMatch);
  const timer=$('#voteTimer');
  if(timer){
    if(isPlayer() && open){
      timer.textContent=`⏱️ Tempo per votare: ${formatCountdown(votingRemainingMs(currentMatch))}`;
      timer.className='pill open';
    }else if(isPlayer() && started){
      timer.textContent=currentMatch.votingClosed===true ? '🔒 Votazioni chiuse dall’Admin' : '⏱️ Finestra di voto terminata';
      timer.className='pill closed';
    }else if(!started){
      timer.textContent='⏱️ Il voto sarà disponibile dopo l’inizio della partita';
      timer.className='pill';
    }
  }
  const adminCard=$('#adminVotingCard');
  if(adminCard){
    const showAdmin=isAdmin()&&String(currentMatch.status||'')==='finished'&&open;
    adminCard.classList.toggle('hidden',!showAdmin);
    const at=$('#adminVoteTimer');
    if(at){ at.textContent=showAdmin?`⏱️ Tempo residuo: ${formatCountdown(votingRemainingMs(currentMatch))}`:(currentMatch.votingClosed===true?'🔒 Votazioni chiuse dall’Admin':''); at.className=showAdmin?'pill open':'pill closed'; }
    const cb=$('#closeVotingBtn');
    if(cb){ cb.disabled=!showAdmin; }
  }
  renderDashboard();
}
async function startVoteTimer(){
  if(voteTimer) clearInterval(voteTimer);
  expiredVoteMatchHandled=null;
  voteTimer=setInterval(async()=>{
    if(!currentMatch) return;
    updateVoteWindowUI();

    // Quando scadono le 6 ore della partita TERMINATA, ricalcoliamo una sola volta
    // la partita corrente. In questo modo la Home può passare alla prossima senza
    // scrivere nulla su Firebase e senza generare query ripetute ogni secondo.
    if(String(currentMatch.status||'')==='finished' && !votingWindowOpen(currentMatch) && expiredVoteMatchHandled!==currentMatch.id){
      expiredVoteMatchHandled=currentMatch.id;
      const expiredId=currentMatch.id;
      try{
        // Se l'Admin/Player sta visualizzando esplicitamente una partita dal Calendario,
        // la scadenza del voto non deve sostituire quella partita con il Next Match.
        // La selezione Home viene ricalcolata solo quando siamo effettivamente in Dashboard.
        const dashboardActive=$('#dashboard')?.classList.contains('active');
        if(dashboardActive){
          await loadMatches();
          if(currentMatch?.id!==expiredId){
            await loadCurrentMatchDetails(currentMatch.id);
            await loadOwnVoteState(currentMatch?.id);
          }
          renderDashboard();
          renderMatch();
        }else{
          updateVoteWindowUI();
          renderMatch();
        }
      }catch(e){ console.error('Aggiornamento partita dopo scadenza voti:',e); }
    }

    // Aggiorna la selezione quando il countdown della prossima partita arriva a zero.
    // È un controllo singolo per partita, non crea richieste ripetute.
    if(currentMatch && String(currentMatch.status||'')==='scheduled'){
      const nextDate=parseDateTime(currentMatch);
      if(nextDate && Date.now()>=nextDate.getTime() && expiredVoteMatchHandled!==`start:${currentMatch.id}`){
        expiredVoteMatchHandled=`start:${currentMatch.id}`;
        const scheduledId=currentMatch.id;
        try{
          // Anche qui, non sostituire una partita aperta manualmente dal Calendario.
          const dashboardActive=$('#dashboard')?.classList.contains('active');
          if(dashboardActive){
            await loadMatches();
            if(currentMatch?.id===scheduledId){
              renderDashboard();
            }else{
              await loadCurrentMatchDetails(currentMatch?.id);
              await loadOwnVoteState(currentMatch?.id);
              renderMatch();
            }
          }else{
            updateVoteWindowUI();
            renderMatch();
          }
        }catch(e){ console.error('Aggiornamento partita allo scadere del countdown:',e); }
      }
    }
  },1000);
  if(voteProgressTimer) clearInterval(voteProgressTimer);
  voteProgressTimer=setInterval(()=>{ if(currentMatch && isAdmin()) updateProgress(); },5000);
}
async function bootApp(){if(!window.currentUserData)return;await loadLeague();await refresh();startVoteTimer();console.log('Best&Fairest Beta.19: tabellini partita e statistiche stagione.');}
window.applyRolePermissions=async userData=>{window.currentUserData=userData;document.querySelectorAll('.admin-only').forEach(b=>b.classList.toggle('hidden',!(userData?.role==='admin'||userData?.role==='superAdmin')));document.querySelectorAll('.superadmin-only').forEach(b=>b.classList.toggle('hidden',userData?.role!=='superAdmin'));await bootApp();};



/* A35.2 RIEPILOGO STAGIONE */
function bfA352RenderSeasonSummary(playerTotals) {
  const root = document.getElementById('bf-a35-season-summary');
  if (!root) return;
  const totals = Object.values(playerTotals || {}).sort((a,b) => (b.net||0) - (a.net||0));
  let out = `
    <div class="bf-a352-card">
      <div class="bf-a352-title">
        <div>
          <h3>📈 Riepilogo totale stagione</h3>
          <p>Totale delle giornate in cui ogni player è stato effettivamente schierato.</p>
        </div>
      </div>
      <div class="bf-a352-table-wrap">
        <table class="bf-a352-table">
          <thead><tr>
            <th>Player</th><th>Giornate</th><th>Punti voto</th>
            <th>🟩</th><th>🟨</th><th>🟥</th><th>Malus</th>
            <th>Netto stagione</th>${isAdmin()?'<th>Voti</th>':''}
          </tr></thead><tbody>`;
  if (!totals.length) {
    out += `<tr><td colspan="9" class="bf-a352-empty">Nessun dato disponibile.</td></tr>`;
  } else {
    totals.forEach(x => {
      out += `<tr>
        <td class="bf-a352-player">${bfA35Escape(x.name)}</td>
        <td>${x.played || 0}</td>
        <td>${x.votePoints || 0}</td>
        <td>${x.green || 0}</td>
        <td>${x.yellow || 0}</td>
        <td>${x.red || 0}</td>
        <td>−${x.malus || 0}</td>
        <td class="bf-a352-net"><strong>${x.net || 0}</strong></td>
        <td>${x.voted || 0}/${x.played || 0}</td>
      </tr>`;
    });
  }
  out += `</tbody></table></div></div>`;
  root.innerHTML = out;
}
