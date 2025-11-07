import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import User from './models/User.js';

dotenv.config();

const OFFLINE_MODE = (() => {
  const flag = process.env.OFFLINE_MODE;
  if (typeof flag === 'string') {
    return flag.trim().toLowerCase() === 'true';
  }
  return true; // varsayılan olarak offline modda başla
})();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MONGO_ENV_KEYS = ['MONGODB_URI', 'MONGO_URI', 'MONGODBURL', 'MONGOURL', 'DATABASE_URL'];
const mongoResolution = (() => {
  for (const key of MONGO_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { uri: value.trim(), key };
    }
  }
  return { uri: undefined, key: null };
})();

const MONGODB_URI = mongoResolution.uri;
const resolvedMongoKey = mongoResolution.key;
const isMongoEnabled = !OFFLINE_MODE && !!MONGODB_URI;
const memoryUsers = new Map();

if (isMongoEnabled) {
  if (resolvedMongoKey && resolvedMongoKey !== 'MONGODB_URI') {
    console.log(`ℹ️ ${resolvedMongoKey} anahtarı bulundu ve Mongo bağlantısı için kullanılıyor. (MONGODB_URI yerine)`);
  }
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.log('MongoDB connection error:', err));
} else {
  if (OFFLINE_MODE) {
    console.log('🚧 Offline mode aktif: MongoDB bağlantısı geçici olarak kapatıldı ve tüm veriler bellek üzerinde tutuluyor.');
  } else {
    const envMongoKeys = Object.keys(process.env).filter(key => key.toLowerCase().includes('mongo'));
    console.log('⚠️ MongoDB devre dışı. Localhost modunda kalıcı veri tutulmayacak.');
    console.log('ℹ️ Sebep: MONGODB_URI environment değişkeni tanımlı değil veya boş.');
    if (envMongoKeys.length > 0) {
      console.log(`ℹ️ Bulunan mongo-* environment anahtarları: ${envMongoKeys.join(', ')}`);
      if (resolvedMongoKey) {
        console.log(`ℹ️ Ancak ${resolvedMongoKey} anahtarının değeri boş olduğu için bağlantı kurulamadı.`);
      }
    }
  }
}

const TICK_HZ = 60;
const BROADCAST_HZ = 30; // increased from 20 for smoother updates
const WORLD_WIDTH = 6000;
const WORLD_HEIGHT = 5200;
const WORLD_RADIUS_X = WORLD_WIDTH / 2;
const WORLD_RADIUS_Y = WORLD_HEIGHT / 2;
const WORLD_CENTER_X = WORLD_WIDTH / 2;
const WORLD_CENTER_Y = WORLD_HEIGHT / 2;
const MAX_SPEED = 180; // px/s - slower for easier aiming
const ACCELERATION = 250; // px/s^2 - slower acceleration
const TURN_SPEED = Math.PI * 1.4; // rad/s - faster turning for better control
const FRICTION = 0.5; // velocity damping per second (much more friction to stop)
const SHIP_RADIUS = 20;
const SHIP_REPULSION_RADIUS = SHIP_RADIUS * 3.4;
const SHIP_REPULSION_FORCE = 1600; // base push force per second when ships get too close
const SHIP_REPULSION_DECAY = 1.8; // per-second decay of magnetic field intensity
const MAX_HP = 100;
const BOT_COUNT = 19;
const TEAM_IDS = ['red', 'blue'];
const TEAM_META = {
  red: { name: 'Kırmızı Takım', color: '#ff5f5f' },
  blue: { name: 'Mavi Takım', color: '#5fb6ff' }
};
const MATCH_LENGTH_MS = 5 * 60 * 1000;
const MATCH_COUNTDOWN_MS = 30 * 1000;
const ASSIST_WINDOW_MS = 6000;
const REQUIRED_NORMAL_MATCHES_FOR_RANKED = 5;
const MAX_PLAYERS_PER_MATCH = 10;
const MIN_PLAYERS_TO_START = 2;
const RANKED_MAX_RP_GAP = 400;
const RANKED_FORFEIT_PENALTY = 75;

const queues = {
  normal: new Map(),
  ranked: new Map()
};
const activeMatchPlayers = new Set();
let currentMatchMode = 'normal';
let lobbyMatchCounter = 0;
const lobbies = new Map(); // lobbyId -> { id, mode, players: Map, ranks, createdAt }

const RANK_TIERS = [
  { min: 0, tier: 'Demir', level: 1 },
  { min: 350, tier: 'Demir', level: 2 },
  { min: 550, tier: 'Demir', level: 3 },
  { min: 750, tier: 'Bronz', level: 1 },
  { min: 980, tier: 'Bronz', level: 2 },
  { min: 1200, tier: 'Bronz', level: 3 },
  { min: 1450, tier: 'Gümüş', level: 1 },
  { min: 1750, tier: 'Gümüş', level: 2 },
  { min: 2050, tier: 'Gümüş', level: 3 },
  { min: 2350, tier: 'Altın', level: 1 },
  { min: 2650, tier: 'Altın', level: 2 },
  { min: 2950, tier: 'Altın', level: 3 },
  { min: 3250, tier: 'Elmas', level: 1 },
  { min: 3550, tier: 'Elmas', level: 2 },
  { min: 3850, tier: 'Elmas', level: 3 },
  { min: 4200, tier: 'Space', level: null }
];
const BULLET_SPEED = 950; // px/s (increased for easier hits)
const BULLET_DAMAGE = 20;
const SHIELD_DAMAGE_MULTIPLIERS = [1, 0.875, 0.75, 0.65];
const BULLET_RADIUS = 6; // increased from 4 for easier hits
const FIRE_COOLDOWN_MS = 500; // ms between shots
const BULLET_TTL_MS = 2500; // longer life (from 2000)
const BULLET_MAX_RANGE = 800; // max distance bullets can travel
const SKILL_COSTS = { speedBoost: [75, 150, 225], shield: [75, 150, 225], rapidFire: [100, 200, 300] };
const WEAPON_COSTS = { cannon: [100, 200, 300], torpedo: [150, 300, 500], missile: [200, 400, 700] };
const ELECTRONICS_COSTS = { radar: [120, 250, 400], sonar: [100, 200, 350], targeting: [180, 350, 600] };
const DEFAULT_SKILLS = { speedBoost: 0, shield: 0, rapidFire: 0 };
const DEFAULT_WEAPONS = { cannon: 1, torpedo: 0, missile: 0 };
const KILL_REWARD = 75; // credits per kill
const SHIP_COLORS = ['#00ff00', '#ff6b9d', '#c9a0dc', '#ffd700', '#00ffff', '#ff8c00', '#7fffd4', '#ff69b4'];
const STREAK_BONUSES = [0, 50, 100, 200, 400, 800]; // bonus credits for streaks
const TORPEDO_COOLDOWN = 3000; // ms
const MISSILE_COOLDOWN = 5000; // ms
const TORPEDO_DAMAGE = 35;
const MISSILE_DAMAGE = 50;

/** @typedef {{
 *  id: string,
 *  name: string,
 *  x: number,
 *  y: number,
 *  angle: number,
 *  vx: number,
 *  vy: number,
 *  thrust: boolean,
 *  turn: number,
 *  lastFireAt: number,
 *  lastTorpedoAt: number,
 *  lastMissileAt: number,
 *  hp: number,
 *  maxHp: number,
 *  isBot: boolean,
 *  score: number,
 *  kills: number,
 *  deaths: number,
 *  level: number,
 *  xp: number,
 *  credits: number,
 *  skills: {speedBoost: number, shield: number, rapidFire: number},
 *  shipColor: string,
 *  killStreak: number,
 *  bestStreak: number,
 *  totalTills: number,
 *  totalScore: number,
 *  weapons: {cannon: number, torpedo: number, missile: number}
 * }} Player
 */

/** @typedef {{ id: number, x: number, y: number, vx: number, vy: number, ownerId: string, createdAt: number, startX: number, startY: number, targetId: string|null }} Bullet */

/** @typedef {{ id: number, x: number, y: number, vx: number, vy: number, ownerId: string, createdAt: number, type: string }} Projectile */

/** @type {Map<string, Player>} */
const players = new Map();
/** @type {Bullet[]} */
let bullets = [];
let nextBulletId = 1;

/** @type {Projectile[]} */
let projectiles = []; // torpedoes and missiles
let nextProjectileId = 1;

/** @typedef {{ id: string, killer: string, killed: string, timestamp: number }} KillEvent */
/** @type {KillEvent[]} */
let recentKills = [];

let teamStats = resetTeamStats();
let matchCountdownEndsAt = Number.POSITIVE_INFINITY;
let matchEndsAt = Number.POSITIVE_INFINITY;
let matchId = 0;
let matchPhase = 'waiting';

function getCountdownMs(now = Date.now()) {
  if (matchPhase !== 'countdown') return 0;
  return Math.max(0, matchCountdownEndsAt - now);
}

function getTimeRemainingMs(now = Date.now()) {
  if (matchPhase !== 'active') return 0;
  return Math.max(0, matchEndsAt - now);
}

function playerCanPlayRanked(player) {
  return (player.normalMatches || 0) >= REQUIRED_NORMAL_MATCHES_FOR_RANKED;
}

function sendQueueStatusToPlayer(player) {
  if (!player) return;
  io.to(player.id).emit('queue:status', {
    mode: player.queueMode || null,
    normalSize: queues.normal.size,
    rankedSize: queues.ranked.size
  });
}

function broadcastQueueSummary() {
  io.emit('queue:summary', {
    normalSize: queues.normal.size,
    rankedSize: queues.ranked.size
  });
}

function leaveQueue(player, silent = false) {
  if (!player || !player.queueMode) return;
  const queue = queues[player.queueMode];
  if (queue) {
    queue.delete(player.id);
  }
  player.queueMode = null;
  if (player.state !== 'inMatch') {
    player.state = 'lobby';
  }
  if (!silent) {
    io.to(player.id).emit('queue:left');
  }
  sendQueueStatusToPlayer(player);
  broadcastQueueSummary();
}

function enqueuePlayer(player, mode, socket) {
  if (!player || player.state === 'inMatch') return;
  const normalized = mode === 'ranked' ? 'ranked' : 'normal';
  if (normalized === 'ranked' && !playerCanPlayRanked(player)) {
    if (socket) {
      socket.emit('queue:error', { message: `Ranked için ${REQUIRED_NORMAL_MATCHES_FOR_RANKED} normal maç tamamlaman gerekiyor.` });
    }
    sendQueueStatusToPlayer(player);
    return;
  }
  if (player.queueMode === normalized) {
    sendQueueStatusToPlayer(player);
    return;
  }
  if (player.queueMode) {
    leaveQueue(player, true);
  }
  player.queueMode = normalized;
  player.state = 'queued';
  const queue = queues[normalized];
  queue.set(player.id, { id: player.id, joinedAt: Date.now() });
  sendQueueStatusToPlayer(player);
  if (socket) {
    socket.emit('queue:joined', { mode: normalized });
  } else {
    io.to(player.id).emit('queue:joined', { mode: normalized });
  }
  broadcastQueueSummary();
  evaluateQueues();
}

function selectRankedGroup(playersInQueue) {
  if (playersInQueue.length < MIN_PLAYERS_TO_START) return null;
  const sorted = [...playersInQueue].sort((a, b) => (a.rankPoints || 0) - (b.rankPoints || 0));
  for (let i = 0; i < sorted.length; i++) {
    const slice = sorted.slice(i, Math.min(sorted.length, i + MAX_PLAYERS_PER_MATCH));
    if (slice.length < MIN_PLAYERS_TO_START) continue;
    const min = slice[0].rankPoints || 0;
    const max = slice[slice.length - 1].rankPoints || 0;
    if (max - min <= RANKED_MAX_RP_GAP || slice.length === sorted.length) {
      return slice;
    }
  }
  return null;
}

function prepareActiveMatch(mode, humanPlayers) {
  activeMatchPlayers.clear();
  const humans = humanPlayers || [];
  const humanIds = humans.map(p => p.id);
  humanIds.forEach(id => activeMatchPlayers.add(id));
  const neededBots = Math.max(0, MAX_PLAYERS_PER_MATCH - humanIds.length);
  if (neededBots > 0) {
    const availableBots = Array.from(players.values()).filter(p => p.isBot);
    for (let i = 0; i < Math.min(neededBots, availableBots.length); i++) {
      activeMatchPlayers.add(availableBots[i].id);
    }
  }
  currentMatchMode = mode;
  for (const p of players.values()) {
    if (activeMatchPlayers.has(p.id)) {
      p.state = 'inMatch';
      p.mode = mode;
      p.isRanked = mode === 'ranked';
      p.queueMode = null;
    } else if (!p.isBot && p.state !== 'queued') {
      p.state = 'lobby';
      p.mode = 'lobby';
      p.isRanked = false;
    }
  }
}

function tryStartMatch(mode) {
  if (matchPhase !== 'waiting') return false;
  const queue = queues[mode];
  if (!queue) return false;
  const candidates = Array.from(queue.keys())
    .map(id => players.get(id))
    .filter(p => p && !p.isBot && p.state !== 'inMatch');
  if (candidates.length === 0) return false;
  let selected;
  if (mode === 'ranked') {
    selected = selectRankedGroup(candidates);
    if (!selected || selected.length === 0) {
      selected = candidates.slice(0, Math.min(MAX_PLAYERS_PER_MATCH, candidates.length));
    }
  } else {
    selected = candidates.slice(0, Math.min(MAX_PLAYERS_PER_MATCH, candidates.length));
  }
  if (!selected || selected.length === 0) return false;
  const availableBots = Array.from(players.values()).filter(p => p.isBot && p.state !== 'inMatch');
  const slotsForBots = Math.max(0, MAX_PLAYERS_PER_MATCH - selected.length);
  const potentialCount = selected.length + Math.min(availableBots.length, slotsForBots);
  if (potentialCount < Math.max(1, MIN_PLAYERS_TO_START)) return false;
  for (const p of selected) {
    queues[mode].delete(p.id);
    p.queueMode = null;
    p.state = 'inMatch';
    io.to(p.id).emit('queue:left');
    sendQueueStatusToPlayer(p);
  }
  prepareActiveMatch(mode, selected);
  broadcastQueueSummary();
  startNewMatch(mode);
  return true;
}

function evaluateQueues() {
  if (matchPhase !== 'waiting') return;
  if (tryStartMatch('ranked')) return;
  tryStartMatch('normal');
}

function randomSpawn(team) {
  if (team) {
    return randomTeamSpawn(team);
  }
  return randomTeamSpawn();
}

function clampPosition(value, max) {
  return Math.max(SHIP_RADIUS, Math.min(max - SHIP_RADIUS, value));
}

function clamp01(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function clampValue(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function clampToEllipse(x, y) {
  const dx = x - WORLD_CENTER_X;
  const dy = y - WORLD_CENTER_Y;
  const nx = dx / (WORLD_RADIUS_X - SHIP_RADIUS);
  const ny = dy / (WORLD_RADIUS_Y - SHIP_RADIUS);
  const distSq = nx * nx + ny * ny;
  if (distSq <= 1) return { x, y };
  const dist = Math.sqrt(distSq) || 1;
  const clampedX = WORLD_CENTER_X + (dx / dist) * (WORLD_RADIUS_X - SHIP_RADIUS);
  const clampedY = WORLD_CENTER_Y + (dy / dist) * (WORLD_RADIUS_Y - SHIP_RADIUS);
  return { x: clampedX, y: clampedY };
}

function isInsideEllipse(x, y) {
  const dx = (x - WORLD_CENTER_X) / (WORLD_RADIUS_X - SHIP_RADIUS);
  const dy = (y - WORLD_CENTER_Y) / (WORLD_RADIUS_Y - SHIP_RADIUS);
  return dx * dx + dy * dy <= 1;
}

function clampPlayerToEllipse(p) {
  const clamped = clampToEllipse(p.x, p.y);
  if (clamped.x !== p.x || clamped.y !== p.y) {
    p.x = clamped.x;
    p.y = clamped.y;
  }
}

function defaultTeamStats() {
  return { score: 0, kills: 0, deaths: 0, assists: 0, credits: 0 };
}

function resetTeamStats() {
  return {
    red: defaultTeamStats(),
    blue: defaultTeamStats()
  };
}

function getTeamCounts() {
  const counts = { red: 0, blue: 0 };
  for (const p of players.values()) {
    if (p.team && counts[p.team] !== undefined) {
      counts[p.team]++;
    }
  }
  return counts;
}

function pickTeamForBot() {
  const counts = getTeamCounts();
  const maxPerTeam = 10;
  if (counts.red >= maxPerTeam) return 'blue';
  if (counts.blue >= maxPerTeam) return 'red';
  if (counts.red === counts.blue) {
    return Math.random() < 0.5 ? 'red' : 'blue';
  }
  return counts.red < counts.blue ? 'red' : 'blue';
}

function pickTeamForPlayer() {
  const counts = getTeamCounts();
  const maxPerTeam = 10;
  const shuffled = [...TEAM_IDS].sort(() => Math.random() - 0.5);
  for (const team of shuffled) {
    if (counts[team] < maxPerTeam) {
      return team;
    }
  }
  return shuffled[0];
}

function randomTeamSpawn(team) {
  const maxAttempts = 60;
  const yRanges = {
    red: { min: WORLD_HEIGHT * 0.6, max: WORLD_HEIGHT * 0.92 },
    blue: { min: WORLD_HEIGHT * 0.08, max: WORLD_HEIGHT * 0.4 }
  };
  const range = yRanges[team] || { min: SHIP_RADIUS, max: WORLD_HEIGHT - SHIP_RADIUS };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = Math.random() * WORLD_WIDTH;
    const y = range.min + Math.random() * (range.max - range.min);
    if (!isInsideEllipse(x, y)) continue;
    let angle;
    if (team === 'red') {
      angle = -Math.PI / 2 + (Math.random() - 0.5) * 0.6; // roughly upwards
    } else if (team === 'blue') {
      angle = Math.PI / 2 + (Math.random() - 0.5) * 0.6; // roughly downwards
    } else {
      angle = Math.random() * Math.PI * 2;
    }
    return { x, y, angle };
  }
  return {
    x: clampPosition(Math.random() * WORLD_WIDTH, WORLD_WIDTH),
    y: clampPosition(Math.random() * WORLD_HEIGHT, WORLD_HEIGHT),
    angle: Math.random() * Math.PI * 2
  };
}

function distanceSq(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

function enemyZonePoint(team) {
  const rawX = WORLD_WIDTH * (0.2 + Math.random() * 0.6);
  const rawY = team === 'red'
    ? WORLD_HEIGHT * (0.18 + Math.random() * 0.12)
    : WORLD_HEIGHT * (0.82 - Math.random() * 0.12);
  const clamped = clampToEllipse(rawX, rawY);
  return { x: clamped.x, y: clamped.y };
}

function friendlyZonePoint(team) {
  const rawX = WORLD_WIDTH * (0.3 + Math.random() * 0.4);
  const rawY = team === 'red'
    ? WORLD_HEIGHT * (0.78 + Math.random() * 0.1)
    : WORLD_HEIGHT * (0.22 - Math.random() * 0.1);
  const clamped = clampToEllipse(rawX, rawY);
  return { x: clamped.x, y: clamped.y };
}

function registerAssist(victim, attackerId) {
  if (!attackerId || victim.id === attackerId) return;
  const attacker = players.get(attackerId);
  if (!attacker || attacker.team && victim.team && attacker.team === victim.team) return;
  if (!victim.assistTracker) victim.assistTracker = {};
  victim.assistTracker[attackerId] = Date.now();
}

function collectAssists(victim, killerId, now) {
  const assists = [];
  const tracker = victim.assistTracker || {};
  for (const attackerId of Object.keys(tracker)) {
    if (attackerId === killerId) continue;
    if (now - tracker[attackerId] <= ASSIST_WINDOW_MS) {
      assists.push(attackerId);
    }
  }
  victim.assistTracker = {};
  return assists;
}

function awardAssists(victim, killerId, now) {
  const assistIds = collectAssists(victim, killerId, now);
  for (const assisterId of assistIds) {
    const assister = players.get(assisterId);
    if (!assister || assister.id === victim.id) continue;
    assister.assists = (assister.assists || 0) + 1;
    assister.score += 60;
    assister.credits += 40;
    if (teamStats[assister.team]) {
      teamStats[assister.team].assists++;
      teamStats[assister.team].credits += 40;
    }
  }
}

function summarizePlayerForMatch(p) {
  const rankInfo = p.rankInfo || resolveRank(p.rankPoints || 0);
  return {
    id: p.id,
    name: p.name,
    team: p.team,
    teamColor: TEAM_META[p.team]?.color,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists || 0,
    credits: p.credits,
    isBot: p.isBot,
    isRanked: p.isRanked,
    mode: p.mode,
    totalDeaths: p.totalDeaths || 0,
    normalMatches: p.normalMatches || 0,
    rank: rankInfo,
    rankPoints: p.rankPoints || 0,
    rankDelta: p.rankDelta || 0
  };
}

function calculateRankPoints(p) {
  const kills = p.kills || 0;
  const deaths = p.deaths || 0;
  const assists = p.assists || 0;
  const score = p.score || 0;
  const kda = (kills + assists) / Math.max(1, deaths);
  const survivalBonus = deaths === 0 && (kills + assists) > 0 ? 160 : 0;
  const base = kills * 140 + assists * 90 - deaths * 45 + kda * 120 + score * 0.35 + survivalBonus;
  return Math.max(0, Math.round(base));
}

function calculateRankDelta(p, result) {
  const kills = p.kills || 0;
  const deaths = p.deaths || 0;
  const assists = p.assists || 0;
  const score = p.score || 0;
  const kda = (kills + assists) / Math.max(1, deaths);
  const victoryBonus = result === 'win' ? 140 : result === 'loss' ? -160 : -40;
  let delta = 0;
  delta += kills * 32;
  delta += assists * 24;
  delta -= deaths * 28;
  delta += Math.min(220, score * 0.08);
  delta += (kda - 1) * 22;
  if (kills + assists === 0 && deaths > 0) delta -= 60;
  if (kills >= 5) delta += 20;
  if (p.killStreak >= 3) delta += (p.killStreak - 2) * 18;
  delta += victoryBonus;
  if (deaths > kills + assists) delta -= (deaths - (kills + assists)) * 14;
  return Math.round(Math.max(-220, Math.min(220, delta)));
}

function resolveRank(points) {
  let chosen = RANK_TIERS[0];
  for (const tier of RANK_TIERS) {
    if (points >= tier.min) {
      chosen = tier;
    } else {
      break;
    }
  }
  const label = chosen.level ? `${chosen.tier} ${chosen.level}` : chosen.tier;
  return { tier: chosen.tier, level: chosen.level, label, points };
}

function defaultBotAI(team) {
  return {
    state: 'advance',
    targetId: null,
    nav: enemyZonePoint(team),
    nextDecisionAt: 0,
    strafeDir: Math.random() < 0.5 ? -1 : 1
  };
}

function getTeamSummary() {
  const counts = getTeamCounts();
  return {
    red: { ...teamStats.red, count: counts.red, color: TEAM_META.red.color, name: TEAM_META.red.name },
    blue: { ...teamStats.blue, count: counts.blue, color: TEAM_META.blue.color, name: TEAM_META.blue.name }
  };
}

function startNewMatch(mode = currentMatchMode) {
  if (matchPhase === 'countdown' || matchPhase === 'active') return;
  if (activeMatchPlayers.size === 0) {
    matchPhase = 'waiting';
    return;
  }
  currentMatchMode = mode;
  teamStats = resetTeamStats();
  matchCountdownEndsAt = Date.now() + MATCH_COUNTDOWN_MS;
  matchEndsAt = matchCountdownEndsAt + MATCH_LENGTH_MS;
  matchId++;
  recentKills = [];
  bullets = [];
  projectiles = [];
  matchPhase = 'countdown';
  for (const p of players.values()) {
    if (!activeMatchPlayers.has(p.id)) {
      if (!p.isBot && p.state !== 'queued') {
        p.thrust = false;
        p.turn = 0;
        p.vx = 0;
        p.vy = 0;
        p.hp = Math.min(p.hp, MAX_HP);
      }
      continue;
    }
    const spawn = randomSpawn(p.team);
    p.x = spawn.x;
    p.y = spawn.y;
    p.angle = spawn.angle;
    p.vx = 0;
    p.vy = 0;
    const level = Math.max(1, p.level || 1);
    p.maxHp = MAX_HP + (level - 1) * 10;
    p.hp = p.maxHp;
    p.magnetic = 0;
    p.score = 0;
    p.kills = 0;
    p.deaths = 0;
    p.assists = 0;
    p.killStreak = 0;
    p.credits = p.isBot ? 999 : Math.max(0, p.credits || 0);
    p.mode = mode;
    p.isRanked = mode === 'ranked';
    if (p.isBot) {
      p.ai = defaultBotAI(p.team);
      p.rankPoints = 0;
      p.rankInfo = resolveRank(0);
      p.rankLabel = p.rankInfo.label;
    } else {
      p.rankInfo = resolveRank(p.rankPoints || 0);
      p.rankLabel = p.rankInfo.label;
    }
    p.rankDelta = 0;
    p.assistTracker = {};
  }
  io.emit('matchStart', {
    id: matchId,
    countdown: MATCH_COUNTDOWN_MS,
    startsAt: matchCountdownEndsAt,
    endsAt: matchEndsAt,
    phase: matchPhase,
    mode,
    teams: getTeamSummary()
  });
}

function endMatch() {
  const redScore = teamStats.red.score;
  const blueScore = teamStats.blue.score;
  let winner = 'draw';
  if (redScore > blueScore) winner = 'red';
  else if (blueScore > redScore) winner = 'blue';

  const playersSummary = [];
  for (const p of players.values()) {
    if (!p.assistTracker) p.assistTracker = {};
    const result = winner === 'draw' ? 'draw' : (p.team === winner ? 'win' : 'loss');
    if (!p.isBot && currentMatchMode === 'normal' && activeMatchPlayers.has(p.id)) {
      p.normalMatches = (p.normalMatches || 0) + 1;
    }
    if (p.isBot) {
      p.rankPoints = 0;
      p.rankDelta = 0;
      p.rankInfo = resolveRank(0);
      p.rankLabel = p.rankInfo.label;
    } else if (p.isRanked) {
      const delta = calculateRankDelta(p, result);
      p.rankDelta = delta;
      p.rankPoints = Math.max(0, (p.rankPoints || 0) + delta);
      p.rankInfo = resolveRank(p.rankPoints);
      p.rankLabel = p.rankInfo.label;
    } else {
      p.rankDelta = 0;
      p.rankPoints = 0;
      p.rankInfo = resolveRank(0);
      p.rankLabel = p.rankInfo.label;
    }
    if (typeof p.rankPoints === 'number') {
      const currentLabel = p.rankLabel || (p.rankInfo ? p.rankInfo.label : resolveRank(p.rankPoints).label);
      if (!p.highestRankPoints || p.rankPoints > p.highestRankPoints) {
        p.highestRankPoints = p.rankPoints;
        p.highestRankLabel = currentLabel;
      } else if (!p.highestRankLabel) {
        p.highestRankLabel = currentLabel;
      }
    }
    p.thrust = false;
    p.turn = 0;
    p.vx = 0;
    p.vy = 0;
    if (!p.isBot) {
      const savePayload = {
        totalKills: p.totalKills,
        totalScore: p.totalScore,
        bestStreak: p.bestStreak,
        totalDeaths: p.totalDeaths || 0,
        shipColor: p.shipColor,
        normalMatches: p.normalMatches || 0,
        rankPoints: p.rankPoints || 0,
        rankLabel: p.rankLabel,
        highestRankPoints: p.highestRankPoints || 0,
        highestRankLabel: p.highestRankLabel || p.rankLabel,
        level: p.level || 1,
        xp: p.xp || 0,
        credits: p.credits || 0,
        skills: { ...p.skills },
        weapons: { ...p.weapons }
      };
      io.to(p.id).emit('saveProgress', savePayload);
      if (p.state === 'inMatch') {
        p.state = 'lobby';
      }
      p.queueMode = null;
      p.isRanked = false;
    } else {
      if (p.state === 'inMatch') {
        p.state = 'lobby';
      }
      p.queueMode = null;
      p.isRanked = false;
      p.mode = 'lobby';
    }
    playersSummary.push(summarizePlayerForMatch(p));
  }
  io.emit('matchEnd', {
    id: matchId,
    winner,
    teams: getTeamSummary(),
    nextCountdown: 0,
    phase: 'ended',
    mode: currentMatchMode,
    players: playersSummary,
    endedAt: Date.now()
  });
  matchPhase = 'waiting';
  matchCountdownEndsAt = Number.POSITIVE_INFINITY;
  matchEndsAt = Number.POSITIVE_INFINITY;
  recentKills = [];
  bullets = [];
  projectiles = [];
  activeMatchPlayers.clear();
  broadcastQueueSummary();
  evaluateQueues();
}

function createPlayer(id, name, isBot = false, persistentData = {}, team = TEAM_IDS[0]) {
  const teamColor = TEAM_META[team]?.color || SHIP_COLORS[0];
  const spawn = randomSpawn(team);
  const initialRankPoints = typeof persistentData.rankPoints === 'number' ? persistentData.rankPoints : 0;
  const initialRankInfo = resolveRank(initialRankPoints);
  const highestRankPoints = typeof persistentData.highestRankPoints === 'number'
    ? persistentData.highestRankPoints
    : initialRankPoints;
  const highestRankLabel = persistentData.highestRankLabel || persistentData.rankLabel || initialRankInfo.label;
  const baseLevel = Math.max(1, Number.isFinite(persistentData.level) ? persistentData.level : 1);
  const maxHp = MAX_HP + (baseLevel - 1) * 10;
  const baseXp = Math.max(0, Number.isFinite(persistentData.xp) ? persistentData.xp : 0);
  const baseCredits = isBot ? 999 : Math.max(0, Number.isFinite(persistentData.credits) ? persistentData.credits : 0);
  const skillsSource = { ...DEFAULT_SKILLS, ...(persistentData.skills || {}) };
  const weaponsSource = { ...DEFAULT_WEAPONS, ...(persistentData.weapons || {}) };
  const playerSkills = {
    speedBoost: clampValue(skillsSource.speedBoost ?? DEFAULT_SKILLS.speedBoost, 0, 3),
    shield: clampValue(skillsSource.shield ?? DEFAULT_SKILLS.shield, 0, 3),
    rapidFire: clampValue(skillsSource.rapidFire ?? DEFAULT_SKILLS.rapidFire, 0, 3)
  };
  const playerWeapons = {
    cannon: clampValue(weaponsSource.cannon ?? DEFAULT_WEAPONS.cannon, 1, 3),
    torpedo: clampValue(weaponsSource.torpedo ?? DEFAULT_WEAPONS.torpedo, 0, 3),
    missile: clampValue(weaponsSource.missile ?? DEFAULT_WEAPONS.missile, 0, 3)
  };
  return {
    id,
    name,
    x: spawn.x,
    y: spawn.y,
    angle: spawn.angle,
    vx: 0,
    vy: 0,
    thrust: false,
    turn: 0,
    lastFireAt: 0,
    lastTorpedoAt: 0,
    lastMissileAt: 0,
    hp: maxHp,
    maxHp,
    isBot,
    score: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    killStreak: 0,
    level: baseLevel,
    xp: baseXp,
    credits: baseCredits,
    skills: playerSkills,
    shipColor: isBot ? teamColor : (persistentData.shipColor || teamColor),
    bestStreak: persistentData.bestStreak || 0,
    totalKills: persistentData.totalKills || 0,
    totalScore: persistentData.totalScore || 0,
    totalDeaths: persistentData.totalDeaths || 0,
    weapons: playerWeapons,
    magnetic: 0,
    team,
    ai: isBot ? defaultBotAI(team) : null,
    assistTracker: {},
    mode: 'lobby',
    isRanked: false,
    normalMatches: persistentData.normalMatches || 0,
    rankInfo: initialRankInfo,
    rankPoints: initialRankPoints,
    rankLabel: initialRankInfo.label,
    highestRankPoints,
    highestRankLabel,
    rankDelta: 0,
    queueMode: null,
    state: 'lobby'
  };
}

function spawnBot() {
  const id = `bot-${Math.random().toString(36).slice(2, 9)}`;
  const name = `Bot-${(Math.random() * 1000 | 0).toString().padStart(3, '0')}`;
  const team = pickTeamForBot();
  const bot = createPlayer(id, name, true, {}, team);
  
  // give bots random skills for variety
  const skillPoints = Math.floor(Math.random() * 7); // 0-6 skill points
  for (let i = 0; i < skillPoints; i++) {
    const skills = ['speedBoost', 'shield', 'rapidFire'];
    const randomSkill = skills[Math.floor(Math.random() * skills.length)];
    if (bot.skills[randomSkill] < 3) {
      bot.skills[randomSkill]++;
    }
  }
  
  // give bots random weapons (50% chance each)
  if (Math.random() > 0.5) {
    bot.weapons.torpedo = 1 + Math.floor(Math.random() * 3); // 1-3
  }
  if (Math.random() > 0.6) {
    bot.weapons.missile = 1 + Math.floor(Math.random() * 3); // 1-3
  }
  bot.weapons.cannon = 1 + Math.floor(Math.random() * 3); // 1-3
  bot.normalMatches = REQUIRED_NORMAL_MATCHES_FOR_RANKED;

  players.set(id, bot);
}

// spawn initial bots
for (let i = 0; i < BOT_COUNT; i++) {
  spawnBot();
}

// Authentication endpoints
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli!' });
    }

    if (!isMongoEnabled) {
      const user = memoryUsers.get(username);
      if (!user) {
        return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı!' });
      }
      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı!' });
      }
      user.lastLogin = new Date();
      if (user.normalMatches === undefined) user.normalMatches = 0;
      if (user.totalDeaths === undefined) user.totalDeaths = 0;
      if (user.rankPoints === undefined) user.rankPoints = 0;
      if (!user.rankLabel) user.rankLabel = user.highestRankLabel || 'Demir 1';
      if (user.highestRankPoints === undefined) user.highestRankPoints = user.rankPoints || 0;
      if (!user.highestRankLabel) user.highestRankLabel = user.rankLabel || 'Demir 1';
      if (user.level === undefined) user.level = 1;
      if (user.xp === undefined) user.xp = 0;
      if (user.credits === undefined) user.credits = 0;
      if (!user.skills) user.skills = { ...DEFAULT_SKILLS };
      if (!user.weapons) user.weapons = { ...DEFAULT_WEAPONS };
      return res.json({
        success: true,
        user: {
          username: user.username,
          totalKills: user.totalKills,
          totalScore: user.totalScore,
          totalDeaths: user.totalDeaths,
          bestStreak: user.bestStreak,
          shipColor: user.shipColor,
          normalMatches: user.normalMatches || 0,
          rankPoints: user.rankPoints || 0,
          rankLabel: user.rankLabel || user.highestRankLabel || 'Demir 1',
          highestRankPoints: user.highestRankPoints || 0,
          highestRankLabel: user.highestRankLabel || (user.rankLabel || 'Demir 1'),
          level: user.level || 1,
          xp: user.xp || 0,
          credits: user.credits || 0,
          skills: { ...DEFAULT_SKILLS, ...(user.skills || {}) },
          weapons: { ...DEFAULT_WEAPONS, ...(user.weapons || {}) }
        }
      });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı!' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı!' });
    }

    user.lastLogin = new Date();
    if (user.normalMatches === undefined) {
      user.normalMatches = 0;
    }
    if (user.totalDeaths === undefined) {
      user.totalDeaths = 0;
    }
    if (user.rankPoints === undefined) {
      user.rankPoints = 0;
    }
    if (!user.rankLabel) {
      user.rankLabel = user.highestRankLabel || 'Demir 1';
    }
    if (user.highestRankPoints === undefined) {
      user.highestRankPoints = user.rankPoints || 0;
    }
    if (!user.highestRankLabel) {
      user.highestRankLabel = user.rankLabel || 'Demir 1';
    }
    if (user.level === undefined) {
      user.level = 1;
    }
    if (user.xp === undefined) {
      user.xp = 0;
    }
    if (user.credits === undefined) {
      user.credits = 0;
    }
    if (!user.skills) {
      user.skills = { ...DEFAULT_SKILLS };
      user.markModified('skills');
    }
    if (!user.weapons) {
      user.weapons = { ...DEFAULT_WEAPONS };
      user.markModified('weapons');
    }
    await user.save();

    res.json({
      success: true,
      user: {
        username: user.username,
        totalKills: user.totalKills,
        totalScore: user.totalScore,
        totalDeaths: user.totalDeaths,
        bestStreak: user.bestStreak,
        shipColor: user.shipColor,
        normalMatches: user.normalMatches || 0,
        rankPoints: user.rankPoints || 0,
        rankLabel: user.rankLabel || user.highestRankLabel || 'Demir 1',
        highestRankPoints: user.highestRankPoints || 0,
        highestRankLabel: user.highestRankLabel || (user.rankLabel || 'Demir 1'),
        level: user.level || 1,
        xp: user.xp || 0,
        credits: user.credits || 0,
        skills: { ...DEFAULT_SKILLS, ...(user.skills?.toObject?.() || user.skills || {}) },
        weapons: { ...DEFAULT_WEAPONS, ...(user.weapons?.toObject?.() || user.weapons || {}) }
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || username.length < 3) {
      return res.status(400).json({ error: 'Kullanıcı adı en az 3 karakter olmalı!' });
    }

    if (!password || password.length < 3) {
      return res.status(400).json({ error: 'Şifre en az 3 karakter olmalı!' });
    }

    if (!isMongoEnabled) {
      if (memoryUsers.has(username)) {
        return res.status(400).json({ error: 'Bu kullanıcı adı zaten alınmış!' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const user = {
        username,
        passwordHash,
        totalKills: 0,
        totalScore: 0,
        totalDeaths: 0,
        bestStreak: 0,
        shipColor: '#ffffff',
        normalMatches: 0,
        rankPoints: 0,
        rankLabel: 'Demir 1',
        highestRankPoints: 0,
        highestRankLabel: 'Demir 1',
        level: 1,
        xp: 0,
        credits: 0,
        skills: { ...DEFAULT_SKILLS },
        weapons: { ...DEFAULT_WEAPONS },
        createdAt: new Date(),
        lastLogin: new Date()
      };
      memoryUsers.set(username, user);
      return res.json({
        success: true,
        user: {
          username: user.username,
          totalKills: 0,
          totalScore: 0,
          totalDeaths: 0,
          bestStreak: 0,
          shipColor: user.shipColor,
          normalMatches: 0,
          rankPoints: 0,
          rankLabel: 'Demir 1',
          highestRankPoints: 0,
          highestRankLabel: 'Demir 1',
          level: 1,
          xp: 0,
          credits: 0,
          skills: { ...DEFAULT_SKILLS },
          weapons: { ...DEFAULT_WEAPONS }
        }
      });
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: 'Bu kullanıcı adı zaten alınmış!' });
    }
    
    const user = new User({ username, password });
    await user.save();
    
    res.json({
      success: true,
      user: {
        username: user.username,
        totalKills: 0,
        totalScore: 0,
        totalDeaths: 0,
        bestStreak: 0,
        shipColor: '#ffffff',
        normalMatches: 0,
        rankPoints: 0,
        rankLabel: 'Demir 1',
        highestRankPoints: 0,
        highestRankLabel: 'Demir 1',
        level: 1,
        xp: 0,
        credits: 0,
        skills: { ...DEFAULT_SKILLS },
        weapons: { ...DEFAULT_WEAPONS }
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

app.post('/api/user/update', async (req, res) => {
  try {
    const { username, updates } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Kullanıcı adı gerekli!' });
    }

    if (!isMongoEnabled) {
      const user = memoryUsers.get(username);
      if (!user) {
        return res.status(404).json({ error: 'Kullanıcı bulunamadı!' });
      }
      if (updates.totalKills !== undefined) user.totalKills = updates.totalKills;
      if (updates.totalScore !== undefined) user.totalScore = updates.totalScore;
      if (updates.bestStreak !== undefined) user.bestStreak = updates.bestStreak;
      if (updates.shipColor) user.shipColor = updates.shipColor;
      if (updates.totalDeaths !== undefined) user.totalDeaths = updates.totalDeaths;
      if (typeof updates.normalMatches === 'number') user.normalMatches = updates.normalMatches;
      if (typeof updates.rankPoints === 'number') user.rankPoints = updates.rankPoints;
      if (updates.rankLabel) user.rankLabel = updates.rankLabel;
      if (typeof updates.highestRankPoints === 'number') {
        user.highestRankPoints = Math.max(user.highestRankPoints || 0, updates.highestRankPoints);
      }
      if (updates.highestRankLabel) user.highestRankLabel = updates.highestRankLabel;
      if (typeof updates.level === 'number') user.level = Math.max(1, Math.floor(updates.level));
      if (typeof updates.xp === 'number') user.xp = Math.max(0, updates.xp);
      if (typeof updates.credits === 'number') user.credits = Math.max(0, updates.credits);
      if (updates.skills) {
        const skills = { ...DEFAULT_SKILLS, ...updates.skills };
        user.skills = {
          speedBoost: clampValue(skills.speedBoost ?? user.skills?.speedBoost ?? 0, 0, 3),
          shield: clampValue(skills.shield ?? user.skills?.shield ?? 0, 0, 3),
          rapidFire: clampValue(skills.rapidFire ?? user.skills?.rapidFire ?? 0, 0, 3)
        };
      }
      if (updates.weapons) {
        const weapons = { ...DEFAULT_WEAPONS, ...updates.weapons };
        user.weapons = {
          cannon: clampValue(weapons.cannon ?? user.weapons?.cannon ?? 1, 1, 3),
          torpedo: clampValue(weapons.torpedo ?? user.weapons?.torpedo ?? 0, 0, 3),
          missile: clampValue(weapons.missile ?? user.weapons?.missile ?? 0, 0, 3)
        };
      }
      return res.json({ success: true });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı!' });
    }

    if (updates.totalKills !== undefined) user.totalKills = updates.totalKills;
    if (updates.totalScore !== undefined) user.totalScore = updates.totalScore;
    if (updates.bestStreak !== undefined) user.bestStreak = updates.bestStreak;
    if (updates.shipColor) user.shipColor = updates.shipColor;
    if (updates.totalDeaths !== undefined) user.totalDeaths = updates.totalDeaths;
    if (typeof updates.normalMatches === 'number') user.normalMatches = updates.normalMatches;
    if (typeof updates.rankPoints === 'number') user.rankPoints = updates.rankPoints;
    if (updates.rankLabel) user.rankLabel = updates.rankLabel;
    if (typeof updates.highestRankPoints === 'number' && updates.highestRankPoints >= (user.highestRankPoints || 0)) {
      user.highestRankPoints = updates.highestRankPoints;
    }
    if (updates.highestRankLabel) user.highestRankLabel = updates.highestRankLabel;
    if (typeof updates.level === 'number') user.level = Math.max(1, Math.floor(updates.level));
    if (typeof updates.xp === 'number') user.xp = Math.max(0, updates.xp);
    if (typeof updates.credits === 'number') user.credits = Math.max(0, updates.credits);
    if (updates.skills) {
      const skills = { ...DEFAULT_SKILLS, ...updates.skills };
      user.skills = user.skills || {};
      user.skills.speedBoost = clampValue(skills.speedBoost ?? user.skills.speedBoost ?? 0, 0, 3);
      user.skills.shield = clampValue(skills.shield ?? user.skills.shield ?? 0, 0, 3);
      user.skills.rapidFire = clampValue(skills.rapidFire ?? user.skills.rapidFire ?? 0, 0, 3);
      user.markModified('skills');
    }
    if (updates.weapons) {
      const weapons = { ...DEFAULT_WEAPONS, ...updates.weapons };
      user.weapons = user.weapons || {};
      user.weapons.cannon = clampValue(weapons.cannon ?? user.weapons.cannon ?? 1, 1, 3);
      user.weapons.torpedo = clampValue(weapons.torpedo ?? user.weapons.torpedo ?? 0, 0, 3);
      user.weapons.missile = clampValue(weapons.missile ?? user.weapons.missile ?? 0, 0, 3);
      user.markModified('weapons');
    }

    await user.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

io.on('connection', socket => {
  console.log('Player connected:', socket.id);
  
  // Create player immediately for backwards compatibility
  const defaultName = `Pilot-${(Math.random() * 1000 | 0).toString().padStart(3, '0')}`;
  const team = pickTeamForPlayer();
  const player = createPlayer(socket.id, defaultName, false, {}, team);
  players.set(socket.id, player);

  socket.emit('init', {
    id: socket.id,
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
    name: player.name,
    availableColors: SHIP_COLORS,
    team: player.team,
    teamMeta: TEAM_META,
    match: {
      id: matchId,
      countdown: getCountdownMs(),
      timeRemaining: getTimeRemainingMs(),
      phase: matchPhase,
      teams: getTeamSummary()
    }
  });
  sendQueueStatusToPlayer(player);
  
  // Handle join event for updating name and persistent data
  socket.on('join', (data) => {
     const p = players.get(socket.id);
     if (p) {
       p.name = data.name || p.name;
       if (data.persistentData) {
         p.totalKills = data.persistentData.totalKills || 0;
         p.totalScore = data.persistentData.totalScore || 0;
         p.bestStreak = data.persistentData.bestStreak || 0;
         p.shipColor = data.persistentData.shipColor || SHIP_COLORS[0];
        p.normalMatches = data.persistentData.normalMatches || p.normalMatches || 0;
        p.totalDeaths = data.persistentData.totalDeaths || p.totalDeaths || 0;
        if (typeof data.persistentData.rankPoints === 'number') {
          p.rankPoints = data.persistentData.rankPoints;
          p.rankInfo = resolveRank(p.rankPoints);
          p.rankLabel = p.rankInfo.label;
        }
        if (typeof data.persistentData.highestRankPoints === 'number') {
          p.highestRankPoints = Math.max(data.persistentData.highestRankPoints, p.rankPoints || 0);
        }
        if (data.persistentData.rankLabel) {
          p.rankLabel = data.persistentData.rankLabel;
        }
        if (data.persistentData.highestRankLabel) {
          p.highestRankLabel = data.persistentData.highestRankLabel;
        } else if (!p.highestRankLabel) {
          p.highestRankLabel = p.rankLabel;
        }
        if (typeof data.persistentData.level === 'number' && data.persistentData.level >= 1) {
          p.level = Math.max(1, Math.floor(data.persistentData.level));
          p.maxHp = MAX_HP + (p.level - 1) * 10;
          p.hp = p.maxHp;
        }
        if (typeof data.persistentData.xp === 'number' && data.persistentData.xp >= 0) {
          p.xp = data.persistentData.xp;
        }
        if (!p.isBot && typeof data.persistentData.credits === 'number') {
          p.credits = Math.max(0, data.persistentData.credits);
        }
        if (data.persistentData.skills) {
          const skills = { ...DEFAULT_SKILLS, ...data.persistentData.skills };
          p.skills.speedBoost = clampValue(skills.speedBoost ?? p.skills.speedBoost, 0, 3);
          p.skills.shield = clampValue(skills.shield ?? p.skills.shield, 0, 3);
          p.skills.rapidFire = clampValue(skills.rapidFire ?? p.skills.rapidFire, 0, 3);
        }
        if (data.persistentData.weapons) {
          const weapons = { ...DEFAULT_WEAPONS, ...data.persistentData.weapons };
          p.weapons.cannon = clampValue(weapons.cannon ?? p.weapons.cannon, 1, 3);
          p.weapons.torpedo = clampValue(weapons.torpedo ?? p.weapons.torpedo, 0, 3);
          p.weapons.missile = clampValue(weapons.missile ?? p.weapons.missile, 0, 3);
        }
       }
      sendQueueStatusToPlayer(p);
      broadcastQueueSummary();
      evaluateQueues();
     }
   });

  socket.on('queue:join', payload => {
    const player = players.get(socket.id);
    if (!player) return;
    const mode = payload && payload.mode === 'ranked' ? 'ranked' : 'normal';
    enqueuePlayer(player, mode, socket);
  });

  socket.on('queue:leave', () => {
    const player = players.get(socket.id);
    if (!player) return;
    leaveQueue(player);
  });

  socket.on('ranked:forfeit', () => {
    const player = players.get(socket.id);
    if (!player) {
      socket.emit('ranked:forfeit:result', { success: false, error: 'Oyuncu bulunamadı.' });
      return;
    }

    const isInRankedMatch = player.isRanked && player.state === 'inMatch' && currentMatchMode === 'ranked' && (matchPhase === 'countdown' || matchPhase === 'active');
    if (!isInRankedMatch) {
      socket.emit('ranked:forfeit:result', { success: false, error: 'Şu anda ranked maçtan ayrılamazsın.' });
      return;
    }

    const penalty = Math.max(0, RANKED_FORFEIT_PENALTY);
    const previousPoints = player.rankPoints || 0;
    player.rankPoints = Math.max(0, previousPoints - penalty);
    player.rankInfo = resolveRank(player.rankPoints);
    player.rankLabel = player.rankInfo.label;
    player.rankDelta = -penalty;
    if (!player.highestRankPoints || player.highestRankPoints < player.rankPoints) {
      player.highestRankPoints = player.rankPoints;
      player.highestRankLabel = player.rankLabel;
    }

    activeMatchPlayers.delete(player.id);
    leaveQueue(player, true);
    broadcastQueueSummary();
    player.state = 'lobby';
    player.mode = 'lobby';
    player.isRanked = false;
    player.queueMode = null;
    player.thrust = false;
    player.turn = 0;
    player.vx = 0;
    player.vy = 0;
    player.hp = 0;

    const savePayload = {
      totalKills: player.totalKills,
      totalScore: player.totalScore,
      bestStreak: player.bestStreak,
      totalDeaths: player.totalDeaths || 0,
      shipColor: player.shipColor,
      normalMatches: player.normalMatches || 0,
      rankPoints: player.rankPoints || 0,
      rankLabel: player.rankLabel,
      highestRankPoints: player.highestRankPoints || 0,
      highestRankLabel: player.highestRankLabel || player.rankLabel,
      level: player.level || 1,
      xp: player.xp || 0,
      credits: player.credits || 0,
      skills: player.skills,
      weapons: player.weapons
    };
    io.to(player.id).emit('saveProgress', savePayload);

    socket.emit('ranked:forfeit:result', {
      success: true,
      penalty,
      rankPoints: player.rankPoints,
      rankLabel: player.rankLabel,
      highestRankPoints: player.highestRankPoints || 0,
      highestRankLabel: player.highestRankLabel || player.rankLabel
    });

    setTimeout(() => {
      if (socket.connected) {
        socket.disconnect(true);
      }
    }, 150);
  });

  socket.on('input', data => {
    const p = players.get(socket.id);
    if (!p) return;
    if (typeof data.thrust === 'boolean') p.thrust = data.thrust;
    if (typeof data.turn === 'number') p.turn = Math.max(-1, Math.min(1, data.turn));
  });

  socket.on('fire', (data) => {
    const p = players.get(socket.id);
    if (!p || p.hp <= 0) return;
    if (matchPhase !== 'active') return;
    const now = Date.now();
    
    // rapid fire skill reduces cooldown
    const cooldown = FIRE_COOLDOWN_MS * (1 - p.skills.rapidFire * 0.15);
    if (now - p.lastFireAt < cooldown) return;
    p.lastFireAt = now;
    
    // use provided angle from mouse or current ship angle
    let fireAngle = p.angle;
    if (data && typeof data.angle === 'number') {
      fireAngle = data.angle;
      p.angle = fireAngle; // instantly rotate ship to fire angle
    }
    
    // no auto-targeting (electronics removed)
    let targetId = null;
    
    const bulletVx = Math.cos(fireAngle) * BULLET_SPEED;
    const bulletVy = Math.sin(fireAngle) * BULLET_SPEED;
    const startX = p.x + Math.cos(fireAngle) * 25;
    const startY = p.y + Math.sin(fireAngle) * 25;
    bullets.push({
      id: nextBulletId++,
      x: startX,
      y: startY,
      vx: bulletVx,
      vy: bulletVy,
      ownerId: socket.id,
      createdAt: now,
      startX: startX,
      startY: startY,
      targetId: targetId
    });
  });
  
  socket.on('upgradeSkill', (skillName) => {
    const p = players.get(socket.id);
    if (!p) return;
    if (skillName === 'speedBoost' || skillName === 'shield' || skillName === 'rapidFire') {
      const currentLevel = p.skills[skillName];
      if (currentLevel < 3) { // max level 3
        const cost = SKILL_COSTS[skillName][currentLevel];
        if (p.credits >= cost) {
          p.credits -= cost;
          p.skills[skillName]++;
        }
      }
    }
  });
  
  socket.on('changeColor', (colorIndex) => {
    const p = players.get(socket.id);
    if (!p || p.isBot) return;
    if (colorIndex >= 0 && colorIndex < SHIP_COLORS.length) {
      p.shipColor = SHIP_COLORS[colorIndex];
    }
  });
  
  socket.on('upgradeWeapon', (weaponName) => {
    const p = players.get(socket.id);
    if (!p) return;
    if (weaponName === 'cannon' || weaponName === 'torpedo' || weaponName === 'missile') {
      const currentLevel = p.weapons[weaponName];
      if (currentLevel < 3) {
        const cost = WEAPON_COSTS[weaponName][currentLevel];
        if (p.credits >= cost) {
          p.credits -= cost;
          p.weapons[weaponName]++;
        }
      }
    }
  });
  
  
  socket.on('fireTorpedo', (data) => {
    const p = players.get(socket.id);
    if (!p || p.hp <= 0 || p.weapons.torpedo === 0) return;
    if (matchPhase !== 'active') return;
    const now = Date.now();
    if (now - p.lastTorpedoAt < TORPEDO_COOLDOWN) return;
    p.lastTorpedoAt = now;
    
    let fireAngle = p.angle;
    if (data && typeof data.angle === 'number') {
      fireAngle = data.angle;
    }
    
    const speed = 500;
    projectiles.push({
      id: nextProjectileId++,
      x: p.x + Math.cos(fireAngle) * 30,
      y: p.y + Math.sin(fireAngle) * 30,
      vx: Math.cos(fireAngle) * speed,
      vy: Math.sin(fireAngle) * speed,
      ownerId: socket.id,
      createdAt: now,
      type: 'torpedo'
    });
  });
  
  socket.on('fireMissile', (data) => {
    const p = players.get(socket.id);
    if (!p || p.hp <= 0 || p.weapons.missile === 0) return;
    if (matchPhase !== 'active') return;
    const now = Date.now();
    if (now - p.lastMissileAt < MISSILE_COOLDOWN) return;
    p.lastMissileAt = now;
    
    let fireAngle = p.angle;
    if (data && typeof data.angle === 'number') {
      fireAngle = data.angle;
    }
    
    const speed = 400;
    projectiles.push({
      id: nextProjectileId++,
      x: p.x + Math.cos(fireAngle) * 30,
      y: p.y + Math.sin(fireAngle) * 30,
      vx: Math.cos(fireAngle) * speed,
      vy: Math.sin(fireAngle) * speed,
      ownerId: socket.id,
      createdAt: now,
      type: 'missile'
    });
  });

  socket.on('requestMatchStart', () => {
    evaluateQueues();
  });

  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (player) {
      leaveQueue(player, true);
      activeMatchPlayers.delete(player.id);
      players.delete(socket.id);
      broadcastQueueSummary();
      evaluateQueues();
    } else {
      players.delete(socket.id);
    }
  });
});

let lastTick = Date.now();
let botThinkTimer = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000); // clamp large frames
  lastTick = now;
  botThinkTimer += dt;
  if (matchPhase === 'countdown' && now >= matchCountdownEndsAt) {
    matchPhase = 'active';
  }
  const matchActive = matchPhase === 'active';
  if (matchActive && now >= matchEndsAt) {
    endMatch();
    return;
  }

  // bot AI (every 0.3s for smarter reactions)
  if (botThinkTimer >= 0.3) {
     botThinkTimer = 0;
    if (!matchActive) {
      for (const bot of players.values()) {
        if (bot.isBot) {
          bot.thrust = false;
          bot.turn = 0;
        }
      }
    } else {
      for (const bot of players.values()) {
        if (!bot.isBot || bot.hp <= 0) continue;
        if (!bot.ai) bot.ai = defaultBotAI(bot.team);
        const ai = bot.ai;

        // find nearest enemy
        let nearestEnemy = null;
        let minDist = Infinity;
        for (const other of players.values()) {
          if (other.id === bot.id || other.hp <= 0) continue;
          if (other.team && bot.team && other.team === bot.team) continue;
          const dist = distanceSq(bot.x, bot.y, other.x, other.y);
          if (dist < minDist) {
            minDist = dist;
            nearestEnemy = other;
          }
        }

        const hasEnemy = !!nearestEnemy;
        const dist = hasEnemy ? Math.sqrt(minDist) : Infinity;
        const enemyAngle = hasEnemy ? Math.atan2(nearestEnemy.y - bot.y, nearestEnemy.x - bot.x) : bot.angle;

        if (hasEnemy) {
          ai.targetId = nearestEnemy.id;
          if (bot.hp < 35 && dist < 450) {
            ai.state = 'retreat';
            ai.nav = friendlyZonePoint(bot.team);
            ai.nextDecisionAt = now + 1200;
          } else {
            ai.state = 'attack';
            if (now >= ai.nextDecisionAt) {
              ai.strafeDir = Math.random() < 0.5 ? -1 : 1;
              ai.nextDecisionAt = now + 900 + Math.random() * 600;
            }
          }
        } else if (!ai.nav || distanceSq(bot.x, bot.y, ai.nav.x, ai.nav.y) < 120 * 120 || now >= ai.nextDecisionAt) {
          ai.state = 'advance';
          ai.nav = enemyZonePoint(bot.team);
          ai.nextDecisionAt = now + 2000 + Math.random() * 2000;
        }

        let desiredAngle = bot.angle;
        let thrust = true;
        if (ai.state === 'attack' && hasEnemy) {
          let angleDiff = enemyAngle - bot.angle;
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          desiredAngle = enemyAngle + ai.strafeDir * 0.25;
          const turnStrength = Math.max(-1, Math.min(1, angleDiff * 1.6));
          bot.turn = Math.max(-1, Math.min(1, turnStrength + ai.strafeDir * 0.35));
          if (dist > 260) {
            thrust = true;
          } else if (dist < 160) {
            thrust = false;
            bot.turn += ai.strafeDir * 0.6;
          }
        } else if (ai.state === 'retreat') {
          const nav = ai.nav || friendlyZonePoint(bot.team);
          const navAngle = Math.atan2(nav.y - bot.y, nav.x - bot.x);
          let angleDiff = navAngle - bot.angle;
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          bot.turn = Math.max(-1, Math.min(1, angleDiff * 1.8));
          thrust = true;
          if (distanceSq(bot.x, bot.y, nav.x, nav.y) < 180 * 180) {
            ai.state = 'advance';
            ai.nextDecisionAt = now + 1500;
          }
        } else {
          const nav = ai.nav || enemyZonePoint(bot.team);
          const navAngle = Math.atan2(nav.y - bot.y, nav.x - bot.x);
          let angleDiff = navAngle - bot.angle;
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          bot.turn = Math.max(-1, Math.min(1, angleDiff * 1.5));
          thrust = true;
          if (distanceSq(bot.x, bot.y, nav.x, nav.y) < 160 * 160) {
            ai.nav = enemyZonePoint(bot.team);
            ai.nextDecisionAt = now + 2000 + Math.random() * 2000;
          }
        }

        // avoid walls gently
        const wallMargin = 180;
        if (bot.x < wallMargin || bot.x > WORLD_WIDTH - wallMargin ||
            bot.y < wallMargin || bot.y > WORLD_HEIGHT - wallMargin) {
          const angleToCenter = Math.atan2(WORLD_CENTER_Y - bot.y, WORLD_CENTER_X - bot.x);
          let angleDiff = angleToCenter - bot.angle;
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          bot.turn = Math.max(-1, Math.min(1, angleDiff * 1.7));
          thrust = true;
        }

        bot.thrust = thrust;
        bot.turn = Math.max(-1, Math.min(1, bot.turn));
 
        // firing decisions
        if (hasEnemy) {
          const aimDiff = enemyAngle - bot.angle;
          let normalized = aimDiff;
          while (normalized > Math.PI) normalized -= Math.PI * 2;
          while (normalized < -Math.PI) normalized += Math.PI * 2;
          const aimAligned = Math.abs(normalized) < 0.35;
          if (aimAligned) {
            if (bot.weapons.missile > 0 && dist > 400 && now - bot.lastMissileAt >= MISSILE_COOLDOWN) {
              bot.lastMissileAt = now;
              const speed = 400;
              projectiles.push({
                id: nextProjectileId++,
                x: bot.x + Math.cos(bot.angle) * 30,
                y: bot.y + Math.sin(bot.angle) * 30,
                vx: Math.cos(bot.angle) * speed,
                vy: Math.sin(bot.angle) * speed,
                ownerId: bot.id,
                createdAt: now,
                type: 'missile'
              });
            } else if (bot.weapons.torpedo > 0 && dist > 250 && dist < 700 && now - bot.lastTorpedoAt >= TORPEDO_COOLDOWN) {
              bot.lastTorpedoAt = now;
              const speed = 500;
              projectiles.push({
                id: nextProjectileId++,
                x: bot.x + Math.cos(bot.angle) * 30,
                y: bot.y + Math.sin(bot.angle) * 30,
                vx: Math.cos(bot.angle) * speed,
                vy: Math.sin(bot.angle) * speed,
                ownerId: bot.id,
                createdAt: now,
                type: 'torpedo'
              });
            } else if (now - bot.lastFireAt >= FIRE_COOLDOWN_MS * (1 - bot.skills.rapidFire * 0.15)) {
              bot.lastFireAt = now;
              const bulletVx = Math.cos(bot.angle) * BULLET_SPEED;
              const bulletVy = Math.sin(bot.angle) * BULLET_SPEED;
              const startX = bot.x + Math.cos(bot.angle) * 25;
              const startY = bot.y + Math.sin(bot.angle) * 25;
              bullets.push({
                id: nextBulletId++,
                x: startX,
                y: startY,
                vx: bulletVx,
                vy: bulletVy,
                ownerId: bot.id,
                createdAt: now,
                startX: startX,
                startY: startY,
                targetId: null
              });
            }
          }
        }
      }
    }
  }

  for (const p of players.values()) {
    p.magnetic = Math.max(0, p.magnetic - SHIP_REPULSION_DECAY * dt);
    if (p.hp <= 0) continue;

    if (!matchActive) {
      p.thrust = false;
      p.turn = 0;
    }

    // turning
    p.angle += p.turn * TURN_SPEED * dt;

    // thrust with speed boost skill
    const accelMultiplier = 1 + (p.skills.speedBoost * 0.2);
    const maxSpeedMultiplier = 1 + (p.skills.speedBoost * 0.2);
    
    if (p.thrust && matchActive) {
      p.vx += Math.cos(p.angle) * ACCELERATION * accelMultiplier * dt;
      p.vy += Math.sin(p.angle) * ACCELERATION * accelMultiplier * dt;
    }

    // friction
    p.vx *= Math.pow(FRICTION, dt);
    p.vy *= Math.pow(FRICTION, dt);

    // clamp speed
    const speed = Math.hypot(p.vx, p.vy);
    const effectiveMaxSpeed = MAX_SPEED * maxSpeedMultiplier;
    if (speed > effectiveMaxSpeed) {
      const s = effectiveMaxSpeed / speed;
      p.vx *= s;
      p.vy *= s;
    }

    // integrate with boundary clamping
    const nextX = p.x + p.vx * dt;
    const nextY = p.y + p.vy * dt;
    if (isInsideEllipse(nextX, nextY)) {
      p.x = nextX;
      p.y = nextY;
    } else {
      const dx = nextX - p.x;
      const dy = nextY - p.y;
      const insidePoint = clampToEllipse(nextX, nextY);
      const normalX = (insidePoint.x - WORLD_CENTER_X) / (WORLD_RADIUS_X - SHIP_RADIUS);
      const normalY = (insidePoint.y - WORLD_CENTER_Y) / (WORLD_RADIUS_Y - SHIP_RADIUS);
      const normalMagnitude = Math.hypot(normalX, normalY) || 1;
      const nx = normalX / normalMagnitude;
      const ny = normalY / normalMagnitude;
      // remove velocity component pointing outward, keep tangential slide
      const dot = p.vx * nx + p.vy * ny;
      if (dot > 0) {
        p.vx -= dot * nx;
        p.vy -= dot * ny;
      }
      // stay at previous position (inside)
    }

    // bots may decide how to react; no forced steering during countdown either
  }

  // update bullets with tracking
  for (const bullet of bullets) {
    // homing behavior if has target
    if (bullet.targetId) {
      const target = players.get(bullet.targetId);
      if (target && target.hp > 0) {
        const dx = target.x - bullet.x;
        const dy = target.y - bullet.y;
        const dist = Math.hypot(dx, dy);
        
        if (dist > 0) {
          const targetAngle = Math.atan2(dy, dx);
          const currentAngle = Math.atan2(bullet.vy, bullet.vx);
          let angleDiff = targetAngle - currentAngle;
          
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          
          // homing strength (0.15 = subtle tracking)
          const homingStrength = 0.15;
          const newAngle = currentAngle + angleDiff * homingStrength;
          
          bullet.vx = Math.cos(newAngle) * BULLET_SPEED;
          bullet.vy = Math.sin(newAngle) * BULLET_SPEED;
        }
      }
    }
    
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
  }
  
  // update projectiles (torpedo, missile)
  for (const proj of projectiles) {
    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;
  }

  // bullet collisions with players
  const bulletsToRemove = new Set();
  for (const bullet of bullets) {
    const shooter = players.get(bullet.ownerId);
    for (const p of players.values()) {
      if (p.id === bullet.ownerId || p.hp <= 0) continue;
      if (shooter && shooter.team && p.team && shooter.team === p.team) continue;
      if (!isInsideEllipse(p.x, p.y)) continue;
      const distSq = distanceSq(bullet.x, bullet.y, p.x, p.y);
      const hitDist = SHIP_RADIUS + BULLET_RADIUS;
      if (distSq < hitDist * hitDist) {
        // shield skill reduces damage
        const shieldLevel = Math.max(0, Math.min(3, p.skills?.shield ?? 0));
        const damage = BULLET_DAMAGE * (SHIELD_DAMAGE_MULTIPLIERS[shieldLevel] ?? SHIELD_DAMAGE_MULTIPLIERS[0]);
        p.hp = Math.max(0, p.hp - damage);
        bulletsToRemove.add(bullet.id);
        if (shooter && shooter.id !== p.id && shooter.team !== p.team) {
          registerAssist(p, shooter.id);
        }
        
        // award score, kill, XP and credits to shooter
        if (p.hp <= 0) {
          const nowTs = Date.now();
          if (shooter) {
            shooter.killStreak++;
            shooter.kills++;
            shooter.totalKills++;
            
            // heal shooter on kill
            shooter.hp = Math.min(shooter.maxHp, shooter.hp + 50);
            
            // loot system: 25% to killer, 25% stays, 50% lost
            const lootedCredits = Math.floor(p.credits * 0.25);
            shooter.credits += lootedCredits;
            p.credits = Math.floor(p.credits * 0.25); // victim keeps 25%
            
            // streak bonuses
            const streakBonus = shooter.killStreak >= 5 ? STREAK_BONUSES[Math.min(5, shooter.killStreak - 2)] : 0;
            const baseReward = 100;
            const totalReward = baseReward + streakBonus;
            
            shooter.score += totalReward;
            shooter.totalScore += totalReward;
            shooter.xp += 50;
            shooter.credits += KILL_REWARD + (shooter.killStreak >= 3 ? 25 : 0);
            const shooterTeam = TEAM_IDS.includes(shooter.team) ? shooter.team : TEAM_IDS[0];
            if (teamStats[shooterTeam]) {
              teamStats[shooterTeam].kills++;
              teamStats[shooterTeam].score += totalReward;
              teamStats[shooterTeam].credits += lootedCredits + KILL_REWARD + (shooter.killStreak >= 3 ? 25 : 0);
            }
            
            if (shooter.killStreak > shooter.bestStreak) {
              shooter.bestStreak = shooter.killStreak;
            }
            
            // level up check
            const xpForNextLevel = shooter.level * 100;
            if (shooter.xp >= xpForNextLevel) {
              shooter.level++;
              shooter.xp -= xpForNextLevel;
              shooter.maxHp += 10;
              shooter.hp = shooter.maxHp;
            }
            
            // add to kill feed with streak
            recentKills.unshift({
              id: `kill-${Date.now()}-${Math.random()}`,
              killer: shooter.name,
              killed: p.name,
              timestamp: Date.now(),
              streak: shooter.killStreak
            });
            if (recentKills.length > 2) recentKills.pop();
            
            // notify shooter of streak
            if (shooter.killStreak >= 3 && !shooter.isBot) {
              io.to(shooter.id).emit('streak', { streak: shooter.killStreak, bonus: streakBonus });
            }
            awardAssists(p, shooter.id, nowTs);
          } else {
            awardAssists(p, null, nowTs);
          }
          p.deaths++;
          if (!p.isBot) {
            p.totalDeaths = (p.totalDeaths || 0) + 1;
          }
          const victimTeam = TEAM_IDS.includes(p.team) ? p.team : TEAM_IDS[1];
          if (teamStats[victimTeam]) {
            teamStats[victimTeam].deaths++;
          }
          p.killStreak = 0; // reset victim's streak
          
          // emit explosion event to all clients
          io.emit('explosion', { x: p.x, y: p.y });
        }
        break;
      }
    }
  }

  // projectile collisions (torpedo, missile)
  const projectilesToRemove = new Set();
  for (const proj of projectiles) {
    const shooter = players.get(proj.ownerId);
    for (const p of players.values()) {
      if (p.id === proj.ownerId || p.hp <= 0) continue;
      if (!isInsideEllipse(p.x, p.y)) continue;
      if (shooter && shooter.team && p.team && shooter.team === p.team) continue;
      const hitDist = SHIP_RADIUS + 10;
      const distSq = distanceSq(proj.x, proj.y, p.x, p.y);
      if (distSq < hitDist * hitDist) {
        const damage = proj.type === 'torpedo' ? TORPEDO_DAMAGE : MISSILE_DAMAGE;
        p.hp = Math.max(0, p.hp - damage);
        projectilesToRemove.add(proj.id);
        if (shooter && shooter.id !== p.id && shooter.team !== p.team) {
          registerAssist(p, shooter.id);
        }
        
        if (p.hp <= 0) {
          const nowTs = Date.now();
          if (shooter) {
            shooter.killStreak++;
            shooter.kills++;
            shooter.totalKills++;
            
            // heal shooter on kill
            shooter.hp = Math.min(shooter.maxHp, shooter.hp + 50);
            
            // loot system: 25% to killer, 25% kept, 50% lost
            const totalCredits = p.credits;
            const lootedCredits = Math.floor(totalCredits * 0.25); // 25% to killer
            const keptCredits = Math.floor(totalCredits * 0.25); // 25% kept by victim
            // 50% disappears (totalCredits * 0.50)
            
            shooter.credits += lootedCredits;
            p.credits = keptCredits;
            
            const streakBonus = shooter.killStreak >= 5 ? STREAK_BONUSES[Math.min(5, shooter.killStreak - 2)] : 0;
            const baseReward = 150; // higher reward for advanced weapons
            shooter.score += baseReward + streakBonus;
            shooter.totalScore += baseReward + streakBonus;
            shooter.xp += 75;
            shooter.credits += 100;
            const shooterTeam = TEAM_IDS.includes(shooter.team) ? shooter.team : TEAM_IDS[0];
            if (teamStats[shooterTeam]) {
              teamStats[shooterTeam].kills++;
              teamStats[shooterTeam].score += baseReward + streakBonus;
              teamStats[shooterTeam].credits += lootedCredits + 100;
            }
            
            if (shooter.killStreak > shooter.bestStreak) {
              shooter.bestStreak = shooter.killStreak;
            }
            
            recentKills.unshift({
              id: `kill-${Date.now()}-${Math.random()}`,
              killer: shooter.name,
              killed: p.name,
              timestamp: Date.now(),
              streak: shooter.killStreak
            });
            if (recentKills.length > 2) recentKills.pop();
            
            if (shooter.killStreak >= 3 && !shooter.isBot) {
              io.to(shooter.id).emit('streak', { streak: shooter.killStreak, bonus: streakBonus });
            }
            awardAssists(p, shooter.id, nowTs);
          } else {
            awardAssists(p, null, nowTs);
          }
          p.deaths++;
          if (!p.isBot) {
            p.totalDeaths = (p.totalDeaths || 0) + 1;
          }
          const victimTeam = TEAM_IDS.includes(p.team) ? p.team : TEAM_IDS[1];
          if (teamStats[victimTeam]) {
            teamStats[victimTeam].deaths++;
          }
          p.killStreak = 0;
          io.emit('explosion', { x: p.x, y: p.y });
        }
        break;
      }
    }
  }
  
  // remove projectiles
  const projCutoff = Date.now() - 6000;
  projectiles = projectiles.filter(p => !projectilesToRemove.has(p.id) && p.createdAt > projCutoff);
  
  // remove hit bullets, expired bullets, and out-of-range bullets
  const bulletCutoff = Date.now() - BULLET_TTL_MS;
  bullets = bullets.filter(b => {
    if (bulletsToRemove.has(b.id)) return false;
    if (b.createdAt <= bulletCutoff) return false;
    
    // check if bullet exceeded max range
    const distTraveled = Math.hypot(b.x - b.startX, b.y - b.startY);
    if (distTraveled > BULLET_MAX_RANGE) return false;
    
    return true;
  });

  // ship repulsion barrier (no physical collision)
  const alive = Array.from(players.values()).filter(p => p.hp > 0);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i];
      const b = alive[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distSq = dx * dx + dy * dy;
      const minDist = SHIP_REPULSION_RADIUS;
      const minDistSq = minDist * minDist;
      if (distSq < minDistSq) {
        let dist = Math.sqrt(distSq);
        if (dist < 1e-4) {
          const angle = Math.random() * Math.PI * 2;
          dx = Math.cos(angle) * 1e-4;
          dy = Math.sin(angle) * 1e-4;
          dist = 1e-4;
        }
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = minDist - dist;
        const normalized = clamp01(overlap / minDist);
        a.magnetic = Math.max(a.magnetic, normalized);
        b.magnetic = Math.max(b.magnetic, normalized);
        const push = overlap * 0.6;
        a.x = clampPosition(a.x - nx * push, WORLD_WIDTH);
        a.y = clampPosition(a.y - ny * push, WORLD_HEIGHT);
        b.x = clampPosition(b.x + nx * push, WORLD_WIDTH);
        b.y = clampPosition(b.y + ny * push, WORLD_HEIGHT);

        const forceStrength = SHIP_REPULSION_FORCE * (overlap / minDist + 0.2);
        const impulse = forceStrength * dt;
        a.vx -= nx * impulse;
        a.vy -= ny * impulse;
        b.vx += nx * impulse;
        b.vy += ny * impulse;

        const relVx = b.vx - a.vx;
        const relVy = b.vy - a.vy;
        const relAlongNormal = relVx * nx + relVy * ny;
        if (relAlongNormal < 0) {
          const cancel = relAlongNormal * 0.5;
          a.vx += nx * cancel;
          a.vy += ny * cancel;
          b.vx -= nx * cancel;
          b.vy -= ny * cancel;
        }
      }
    }
  }

  for (const p of players.values()) {
    clampPlayerToEllipse(p);
  }

  // respawn dead players/bots
  for (const p of players.values()) {
    if (p.hp <= 0) {
      const spawn = randomSpawn(p.team);
      p.x = spawn.x;
      p.y = spawn.y;
      p.angle = spawn.angle;
      p.vx = 0;
      p.vy = 0;
      p.hp = MAX_HP;
      p.skills = { speedBoost: 0, shield: 0, rapidFire: 0 };
      p.weapons = { cannon: 1, torpedo: 0, missile: 0 };
      p.killStreak = 0;
      p.assistTracker = {};
      if (p.isBot) {
        p.ai = defaultBotAI(p.team);
      }
 
      // only increment death count and save progress for real players
      if (!p.isBot) {
         // send persistent data back to player for localStorage (only stats)
        io.to(p.id).emit('saveProgress', {
          totalKills: p.totalKills,
          totalScore: p.totalScore,
          bestStreak: p.bestStreak,
          shipColor: p.shipColor,
          normalMatches: p.normalMatches || 0
        });
       }
      // credits, skills, weapons, level, xp are NOT reset on death for anyone
    }
  }

  // maintain bot count
  const botCount = Array.from(players.values()).filter(p => p.isBot).length;
  if (botCount < BOT_COUNT) {
    spawnBot();
  }

}, 1000 / TICK_HZ);

setInterval(() => {
  // leaderboard: top 10 players by score
  const leaderboard = Array.from(players.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(p => ({ name: p.name, score: p.score, kills: p.kills, level: p.level }));
  const matchPlayers = Array.from(players.values()).filter(p => activeMatchPlayers.has(p.id));
  const snapshot = {
    t: Date.now(),
    players: matchPlayers.map(p => ({ 
      id: p.id, 
      name: p.name,
      x: p.x, 
      y: p.y, 
      vx: p.vx,
      vy: p.vy,
      angle: p.angle, 
      hp: p.hp, 
      maxHp: p.maxHp,
      isBot: p.isBot,
      score: p.score,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      level: p.level,
      xp: p.xp,
      credits: p.credits,
      skills: p.skills,
      shipColor: p.shipColor,
      killStreak: p.killStreak,
      bestStreak: p.bestStreak,
      totalDeaths: p.totalDeaths || 0,
      weapons: p.weapons,
      magnetic: p.magnetic,
      team: p.team,
      teamColor: TEAM_META[p.team]?.color || p.shipColor,
      rank: p.rankInfo ? p.rankInfo.label : null,
      rankPoints: p.rankPoints || 0,
      rankDelta: p.rankDelta || 0,
      normalMatches: p.normalMatches || 0,
      mode: p.mode,
      state: p.state,
      queueMode: p.queueMode,
      lobbyId: (playerLobby(p.id)?.id) || null,
      isRanked: p.isRanked
    })),
    bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y })),
    projectiles: projectiles.map(p => ({ id: p.id, x: p.x, y: p.y, type: p.type })),
    leaderboard: leaderboard,
    killFeed: recentKills.slice(0, 2),
    match: {
      id: matchId,
      countdown: getCountdownMs(Date.now()),
      timeRemaining: getTimeRemainingMs(Date.now()),
      phase: matchPhase,
      teams: getTeamSummary()
    },
    queues: {
      normal: queues.normal.size,
      ranked: queues.ranked.size
    },
    lobbies: Array.from(lobbies.values()).map(l => ({
      id: l.id,
      mode: l.mode,
      size: l.players.size,
      rankMin: l.rankRange.min,
      rankMax: l.rankRange.max,
      createdAt: l.createdAt
    }))
  };
  io.emit('state', snapshot);
}, 1000 / BROADCAST_HZ);

const PORT = process.env.PORT || 3000;
const HOST = OFFLINE_MODE ? '127.0.0.1' : '0.0.0.0';

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`space-sonar-io listening on http://${OFFLINE_MODE ? '127.0.0.1' : 'localhost'}:${PORT}`);
  if (OFFLINE_MODE) {
    console.log('🔒 Sunucu şu anda sadece local bağlantıları kabul ediyor. Tekrar açmak için OFFLINE_MODE değerini false yapman yeterli.');
  }
});

function createLobby(mode, participants) {
  const id = `lobby-${++lobbyMatchCounter}`;
  const lobby = {
    id,
    mode,
    players: new Map(),
    createdAt: Date.now(),
    rankRange: { min: Infinity, max: -Infinity }
  };
  participants.forEach(p => {
    const rankPoints = p.rankPoints || 0;
    lobby.players.set(p.id, { id: p.id, rankPoints });
    lobby.rankRange.min = Math.min(lobby.rankRange.min, rankPoints);
    lobby.rankRange.max = Math.max(lobby.rankRange.max, rankPoints);
  });
  lobbies.set(id, lobby);
  return lobby;
}

function closeLobby(id) {
  lobbies.delete(id);
}

function playerLobby(id) {
  for (const lobby of lobbies.values()) {
    if (lobby.players.has(id)) return lobby;
  }
  return null;
}


