// ── AUCTION ENGINE ────────────────────────────────────────────
// Handles category grouping, random subcategory rotation,
// bid assignment, RTM logic, unsold tracking

const CATEGORY_LABELS = {
  BAT:       {label:'Batters',       icon:'🏏', color:'#3d9df3'},
  WK:        {label:'Wicket-Keepers',icon:'🧤', color:'#9c5cff'},
  AR:        {label:'All-Rounders',  icon:'⚡', color:'#00d4aa'},
  BOWL_FAST: {label:'Fast Bowlers',  icon:'🔥', color:'#ff4757'},
  BOWL_SPIN: {label:'Spin Bowlers',  icon:'🌀', color:'#f5b800'},
};

// State — persisted in localStorage
let auctionState = {
  subcategories: [],      // all shuffled subcategories queue
  currentSubIdx: 0,       // which subcategory we're on
  currentPlayerIdx: 0,    // which player within subcategory
  soldPlayers: [],        // [{playerId, teamId, ptsSpent, rtmUsed}]
  unsoldPlayers: [],      // [playerId]
  round2Players: [],      // unsold → round 2
  phase: 'auction',       // 'auction' | 'round2' | 'done'
  initialized: false,
};

function saveState() {
  try { localStorage.setItem('kotakIPLState', JSON.stringify({auctionState, teams: OFFICE_TEAMS})); } catch(e){}
}

function loadState() {
  try {
    const raw = localStorage.getItem('kotakIPLState');
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (saved.auctionState) Object.assign(auctionState, saved.auctionState);
    if (saved.teams) {
      saved.teams.forEach((st, i) => {
        if (OFFICE_TEAMS[i]) Object.assign(OFFICE_TEAMS[i], st);
      });
    }
    // Rehydrate player stats
    auctionState.soldPlayers.forEach(sp => {
      const p = PLAYERS.find(x => x.id === sp.playerId);
      if (p) { p.soldTo = sp.teamId; p.soldFor = sp.ptsSpent; }
    });
    auctionState.unsoldPlayers.forEach(pid => {
      const p = PLAYERS.find(x => x.id === pid);
      if (p) p.unsold = true;
    });
    return true;
  } catch(e) { return false; }
}

function buildSubcategories() {
  // Group by role
  const groups = {};
  PLAYERS.forEach(p => {
    if (!groups[p.role]) groups[p.role] = [];
    groups[p.role].push(p.id);
  });

  const allSubs = [];
  Object.keys(groups).forEach(role => {
    const ids = shuffle([...groups[role]]);
    const chunkSize = 7;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      // Sort by base desc within chunk so marquees come first
      chunk.sort((a,b) => {
        const pa = PLAYERS.find(x=>x.id===a), pb = PLAYERS.find(x=>x.id===b);
        return pb.base - pa.base;
      });
      allSubs.push({ role, players: chunk, label: `${CATEGORY_LABELS[role].label} Set ${Math.ceil((i/chunkSize)+1)}` });
    }
  });

  // Shuffle subcategories so categories interleave
  return shuffle(allSubs);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function initAuction() {
  if (loadState() && auctionState.initialized) return;
  auctionState.subcategories = buildSubcategories();
  auctionState.initialized = true;
  saveState();
}

function getCurrentSubcategory() {
  return auctionState.subcategories[auctionState.currentSubIdx] || null;
}

function getCurrentPlayer() {
  const sub = getCurrentSubcategory();
  if (!sub) return null;
  const pid = sub.players[auctionState.currentPlayerIdx];
  return PLAYERS.find(p => p.id === pid) || null;
}

function getAvailableSubcategories() {
  return auctionState.subcategories.filter((sub, idx) => {
    // Has at least one unsold player
    return sub.players.some(pid => {
      const p = PLAYERS.find(x => x.id === pid);
      return p && p.soldTo === undefined && !p.unsold;
    });
  });
}

function assignPlayer(playerId, teamId, ptsSpent, rtmUsed) {
  const p = PLAYERS.find(x => x.id === playerId);
  const t = OFFICE_TEAMS.find(x => x.id === teamId);
  if (!p || !t) return false;
  if (t.squad.length >= 13) return false;

  p.soldTo = teamId;
  p.soldFor = ptsSpent;
  t.points -= ptsSpent;
  t.squad.push({playerId, ptsSpent, rtmUsed: rtmUsed || false});
  if (rtmUsed) t.rtmLeft = Math.max(0, t.rtmLeft - 1);

  auctionState.soldPlayers.push({playerId, teamId, ptsSpent, rtmUsed: rtmUsed||false});
  saveState();
  return true;
}

function markUnsold(playerId) {
  const p = PLAYERS.find(x => x.id === playerId);
  if (!p) return;
  p.unsold = true;
  auctionState.unsoldPlayers.push(playerId);
  auctionState.round2Players.push(playerId);
  saveState();
}

function getUnsoldPlayers() {
  return auctionState.unsoldPlayers.map(id => PLAYERS.find(p => p.id === id)).filter(Boolean);
}

function getRound2Players() {
  return auctionState.round2Players.map(id => PLAYERS.find(p => p.id === id)).filter(Boolean);
}

function getLastYearOwner(player) {
  for (const t of OFFICE_TEAMS) {
    if (!t.lastYearSquad) continue;
    const found = t.lastYearSquad.some(name => {
      const n = name.toLowerCase(), pn = player.name.toLowerCase();
      const nParts = n.split(' '), pParts = pn.split(' ');
      return nParts.some(part => part.length > 3 && pParts.includes(part)) ||
             pParts.some(part => part.length > 3 && nParts.includes(part));
    });
    if (found) return t;
  }
  return null;
}

function canUseRTM(team, player) {
  if (team.rtmLeft <= 0) return false;
  if (team.type === 'returning') {
    return (team.lastYearSquad || []).some(name => {
      const n = name.toLowerCase(), pn = player.name.toLowerCase();
      const nParts = n.split(' '), pParts = pn.split(' ');
      return nParts.some(part => part.length > 3 && pParts.includes(part)) ||
             pParts.some(part => part.length > 3 && nParts.includes(part));
    });
  }
  // Wonder Women: handled separately (after original team passes)
  return false;
}

function getBidIncrement(currentBid) {
  return currentBid >= 300 ? 25 : 10;
}

function getTeamTotalPts(team) {
  return team.matchPts + team.bonusPts;
}

function calcBonuses() {
  // For each bonus category find the winner across all sold players
  const soldWithTeam = auctionState.soldPlayers.map(sp => ({
    player: PLAYERS.find(p => p.id === sp.playerId),
    team: OFFICE_TEAMS.find(t => t.id === sp.teamId)
  })).filter(x => x.player && x.team);

  const cats = [
    {key:'highRuns',   label:'Highest Run Scorer',  fn: x => x.player.runs,    min: p => p.runs >= 100},
    {key:'highWkts',   label:'Highest Wicket Taker',fn: x => x.player.wkts,    min: p => p.wkts >= 1},
    {key:'bestSR',     label:'Best Strike Rate',     fn: x => x.player.sr,      min: p => p.runs >= 100},
    {key:'bestEcon',   label:'Best Economy',         fn: x => -(x.player.econ||99),min: p => p.wkts >= 1},
    {key:'mostFours',  label:'Most Fours',           fn: x => x.player.fours,   min: p => p.runs >= 100},
    {key:'mostSixes',  label:'Most Sixes',           fn: x => x.player.sixes,   min: p => p.runs >= 100},
    {key:'bestBowlAvg',label:'Best Bowling Average', fn: x => -(x.player.bowlAvg||99),min: p => p.wkts >= 1},
    {key:'mostDots',   label:'Most Dot Balls',       fn: x => x.player.dots,    min: p => p.wkts >= 1},
    {key:'mostCatches',label:'Most Catches',         fn: x => x.player.catches, min: _ => true},
  ];

  // Reset bonus pts
  OFFICE_TEAMS.forEach(t => t.bonusPts = 0);

  const results = cats.map(cat => {
    const eligible = soldWithTeam.filter(x => cat.min(x.player));
    if (!eligible.length) return {key:cat.key, label:cat.label, winner:null, team:null, val:0};
    const best = eligible.reduce((a,b) => cat.fn(a) >= cat.fn(b) ? a : b);
    if (best && cat.fn(best) > 0) best.team.bonusPts += 50;
    return {key:cat.key, label:cat.label, winner:best?.player, team:best?.team, val:Math.abs(cat.fn(best||{player:{}}))};
  });

  saveState();
  return results;
}

function recalcMatchPts() {
  OFFICE_TEAMS.forEach(t => {
    // Sort squad by individual contribution desc, take top 11
    const withPts = t.squad.map(s => {
      const p = PLAYERS.find(x => x.id === s.playerId);
      return {s, p, pts: p ? (p.runs||0)*1 + (p.wkts||0)*25 : 0};
    }).sort((a,b) => b.pts - a.pts);
    const top11 = withPts.slice(0, 11);
    t.matchPts = top11.reduce((sum, x) => sum + x.pts, 0);
  });
  saveState();
}

// CricAPI integration
const CRIC_API_BASE = 'https://api.cricapi.com/v1';
let cricApiKey = localStorage.getItem('cricApiKey') || '';

async function fetchIPLScores() {
  if (!cricApiKey) return {ok:false, msg:'No API key set'};
  try {
    const res = await fetch(`${CRIC_API_BASE}/series?apikey=${cricApiKey}&offset=0`);
    const data = await res.json();
    if (!data.status || data.status !== 'success') return {ok:false, msg: data.reason || 'API error'};
    const ipl = (data.data||[]).find(s => s.name && s.name.toLowerCase().includes('ipl') && s.name.includes('2026'));
    return {ok:true, series: ipl};
  } catch(e) { return {ok:false, msg:e.message}; }
}

async function fetchPlayerStats(apiKey) {
  // Returns a map of playerName -> stats from CricAPI
  if (!apiKey) return null;
  try {
    // Use series squad endpoint to get current IPL player list
    const res = await fetch(`${CRIC_API_BASE}/players?apikey=${apiKey}&offset=0`);
    const data = await res.json();
    return data.status === 'success' ? data.data : null;
  } catch(e) { return null; }
}
