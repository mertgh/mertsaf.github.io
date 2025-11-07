const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const loadingOverlay = document.getElementById('loading-overlay');
const loadingMessageEl = document.getElementById('loading-message');
const loadingProgressBar = document.getElementById('loading-progress-bar');
const loadingSubtextEl = document.getElementById('loading-subtext');
let isMatchLoading = false;
let loadingSequenceReady = false;

const environmentCache = {
  seed: '',
  width: 0,
  height: 0,
  background: null,
  nebulas: [],
  farStars: [],
  midStars: [],
  nearStars: []
};

let width = 0, height = 0, dpr = 1;
function resize() {
  dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  width = Math.floor(window.innerWidth);
  height = Math.floor(window.innerHeight);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  invalidateEnvironmentCacheDimensions();
}
window.addEventListener('resize', resize);
resize();

// Main menu handling
let gameStarted = false;
let soundEnabled = true;
let musicEnabled = true;
const bgMusic = document.getElementById('bg-music');

async function showMainMenu() {
  hideRankedLeaveOverlay(true);
  const menu = document.getElementById('main-menu');
  if (menu) menu.classList.remove('hidden');
  if (soundToggleBtn) {
    soundToggleBtn.textContent = soundEnabled ? '🔊 Ses: Açık' : '🔇 Ses: Kapalı';
  }
  updateRankedRequirementDisplay();

  if (registerCard) registerCard.classList.add('hidden');
  clearRegisterForm();
  updateAccountStatus('', 'info');

  if (currentUser) {
    isAuthenticated = true;
    showProfileCard();
    populateMenuStats(currentUser);
    setPlayButtonsEnabled(true);
    if (loginUsernameInput && currentUser.username) {
      loginUsernameInput.value = currentUser.username;
    }
    updateAccountStatus(`✅ Hoş geldin, ${currentUser.username}!`, 'success');
    renderCareerPanel();
    updateRankedRequirementDisplay();
    return;
  }

  isAuthenticated = false;
  showLoginCard();
  setPlayButtonsEnabled(false);

  const savedCreds = localStorage.getItem('space-sonar-creds');
  if (savedCreds) {
    try {
      const { username, password } = JSON.parse(savedCreds);
      if (loginUsernameInput && username) {
        loginUsernameInput.value = username;
      }
      if (username && password) {
        updateAccountStatus('⏳ Oturum açılıyor...', 'info');
        const user = await loginUser(username, password);
        handleAuthSuccess(user, `✅ Hoş geldin, ${user.username || username}!`);
      } else {
        updateAccountStatus('📝 Giriş yap veya yeni hesap oluştur', 'info');
      }
    } catch (error) {
      updateAccountStatus('📝 Giriş yap veya yeni hesap oluştur', 'info');
    }
  } else {
    updateAccountStatus('📝 Giriş yap veya yeni hesap oluştur', 'info');
  }

  renderCareerPanel();
}

function updateAccountStatus(message, type = 'info', targetId = 'account-status') {
  const status = document.getElementById(targetId);
  if (!status) return;
  status.textContent = message || '';
  status.className = `account-status${type ? ` ${type}` : ''}`.trim();
}

function hideMainMenu() {
  const menu = document.getElementById('main-menu');
  if (menu) menu.classList.add('hidden');
}

window.showHelp = function() {
  alert('🎮 NASIL OYNANIR\n\n' +
        '🚀 HAREKET:\n' +
        'W - İleri git\n' +
        'A/D - Sağa/Sola dön\n\n' +
        '🔫 SALDIRI:\n' +
        'Space/Mouse - Ateş et\n' +
        'F - Tam ekran\n' +
        'G - Torpido (unlock gerekli)\n' +
        'H - Füze (unlock gerekli)\n\n' +
        '💰 HEDEF:\n' +
        'Düşmanları öldür, credits kazan\n' +
        'Upgrade al, güçlen\n' +
        'TOP 10\'a gir!\n\n' +
        '⚠️ DİKKAT:\n' +
        'Öldüğünde tüm upgrades sıfırlanır!\n' +
        'Dikkatli oyna, hayatta kal!');
};

window.toggleSound = function() {
  soundEnabled = !soundEnabled;
  musicEnabled = !musicEnabled;

  if (soundToggleBtn) {
    soundToggleBtn.textContent = soundEnabled ? '🔊 Ses: Açık' : '🔇 Ses: Kapalı';
  }
  
  // toggle background music
  if (bgMusic) {
    if (musicEnabled) {
      bgMusic.volume = 0.3;
      bgMusic.play().catch(e => console.log('Music play failed'));
    } else {
      bgMusic.pause();
    }
  }
};

const socket = io({ transports: ['websocket'], upgrade: false, autoConnect: false });

let myId = null;
let world = { width: 6000, height: 5200 };
let myName = '';
let availableColors = [];
let streakNotifications = []; // {text, createdAt}

/** @type {Map<string,{id:string,name:string,x:number,y:number,angle:number,hp:number,maxHp:number,isBot:boolean,score:number,kills:number,deaths:number,level:number,xp:number,credits:number,skills:any,vx:number,vy:number,magnetic:number}>} */
const players = new Map();
const SKILL_COSTS = { speedBoost: [75, 150, 225], shield: [75, 150, 225], rapidFire: [100, 200, 300] };
const DEFAULT_SKILLS = { speedBoost: 0, shield: 0, rapidFire: 0 };
const DEFAULT_WEAPONS = { cannon: 1, torpedo: 0, missile: 0 };
/** @type {{ id:number, x:number, y:number }[]} */
let bullets = [];
/** @type {{ id:number, x:number, y:number, type:string }[]} */
let projectiles = [];
let killFeed = [];
let lastKillFeedUpdate = '';
let explosions = []; // {x, y, createdAt, size}
let particles = []; // {x, y, vx, vy, life, maxLife, color, size}
let damageIndicators = []; // {x, y, damage, createdAt}
let previousPlayerHP = new Map(); // track HP changes
const MATCH_LENGTH_MS = 5 * 60 * 1000;
const MATCH_COUNTDOWN_MS = 30 * 1000;
const SNAPSHOT_INTERVAL_MS = 1000 / 30;
const TAU = Math.PI * 2;
const MAGNETIC_FIELD_BASE_RADIUS = 58;
const MAGNETIC_FIELD_SOFTNESS = 0.35;
const numberFormatter = new Intl.NumberFormat('tr-TR');
const RANKED_FORFEIT_PENALTY = 75;

let matchInfo = { id: 0, timeRemaining: MATCH_LENGTH_MS, countdown: MATCH_COUNTDOWN_MS, phase: 'countdown', teams: {}, players: [] };
let teamMeta = {};
let myTeam = null;
let scoreboardVisible = false;
const scoreboardOverlay = document.getElementById('scoreboard-overlay');
const scoreboardBody = document.getElementById('scoreboard-body');
const rankedLeaveOverlay = document.getElementById('ranked-leave-overlay');
const rankedLeavePenaltyEl = document.getElementById('ranked-leave-penalty');
const rankedLeaveConfirmBtn = document.getElementById('ranked-leave-confirm');
const rankedLeaveCancelBtn = document.getElementById('ranked-leave-cancel');
const rankedLeaveCloseBtn = document.getElementById('ranked-leave-close');
const rankedLeaveConfirmDefaultText = rankedLeaveConfirmBtn ? rankedLeaveConfirmBtn.textContent : 'Rank Cezasını Kabul Et';

let selectedMode = 'normal';
let myMode = 'normal';
let careerFilter = 'all';
let playButtonsAreEnabled = false;
let queueState = { mode: null, normalSize: 0, rankedSize: 0 };

const matchSummaryOverlay = document.getElementById('match-summary-overlay');
const matchSummaryResultEl = document.getElementById('match-summary-result');
const matchSummaryBodyEl = document.getElementById('match-summary-body');
const matchSummaryPlayAgainBtn = document.getElementById('match-summary-play-again');
const matchSummaryExitBtn = document.getElementById('match-summary-exit');
let summaryRestartPending = false;
let latestMatchSummary = null;
let rankedLeaveOverlayVisible = false;
let rankedLeaveRequestPending = false;

function clamp01(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
  let diff = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + diff * t;
}

function normalizeAngle(angle) {
  if (!Number.isFinite(angle)) return 0;
  let wrapped = (angle + Math.PI) % TAU;
  if (wrapped < 0) wrapped += TAU;
  return wrapped - Math.PI;
}

function smoothStep(t) {
  const clamped = clamp01(t);
  return clamped * clamped * (3 - 2 * clamped);
}

function showLoadingScreen(message = 'Harita yükleniyor...', progress = 0, subtext = '') {
  if (!loadingOverlay) return;
  loadingOverlay.classList.remove('hidden');
  isMatchLoading = true;
  loadingSequenceReady = false;
  updateLoadingProgress(progress, message);
  updateLoadingSubtext(subtext);
}

function updateLoadingProgress(progress = 0, message) {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  if (loadingProgressBar) {
    loadingProgressBar.style.width = `${clamped}%`;
  }
  if (loadingMessageEl && message) {
    loadingMessageEl.textContent = message;
  }
}

function updateLoadingSubtext(text = '') {
  if (loadingSubtextEl) {
    loadingSubtextEl.textContent = text || '';
  }
}

function hideLoadingScreen(force = false) {
  if (!loadingOverlay) return;
  if (!isMatchLoading && !force) return;
  isMatchLoading = false;
  loadingSequenceReady = false;
  if (loadingProgressBar) {
    loadingProgressBar.style.width = '0%';
  }
  if (force && loadingMessageEl) {
    loadingMessageEl.textContent = '';
  }
  updateLoadingSubtext('');
  loadingOverlay.classList.add('hidden');
}

function invalidateEnvironmentCacheDimensions() {
  environmentCache.width = 0;
  environmentCache.height = 0;
  environmentCache.background = null;
}

function ensureEnvironmentCache(seed) {
  const targetSeed = seed || 'menu';
  if (!environmentCache.background || environmentCache.seed !== targetSeed || environmentCache.width !== width || environmentCache.height !== height) {
    prepareEnvironmentCache(targetSeed);
  }
}

function prepareEnvironmentCache(seed) {
  const targetSeed = seed || 'menu';
  const targetWidth = Math.max(1, width);
  const targetHeight = Math.max(1, height);
  const rng = createSeededRng(`${targetSeed}:${targetWidth}x${targetHeight}`);
  const worldWidth = Math.max(1, world?.width || 6000);
  const worldHeight = Math.max(1, world?.height || 5200);

  environmentCache.seed = targetSeed;
  environmentCache.width = targetWidth;
  environmentCache.height = targetHeight;
  environmentCache.background = generateBackgroundCanvas(rng, targetWidth, targetHeight);
  environmentCache.nebulas = generateNebulas(rng, Math.max(6, Math.floor((worldWidth + worldHeight) / 1600)));
  environmentCache.farStars = generateStarField(rng, Math.max(120, Math.floor((worldWidth + worldHeight) / 30)), [0.18, 0.28], [1.2, 1.8], [[137, 180, 250], [168, 196, 255], [140, 197, 255]]);
  environmentCache.midStars = generateStarField(rng, Math.max(150, Math.floor((worldWidth + worldHeight) / 26)), [0.35, 0.5], [1.4, 2.2], [[214, 226, 255], [190, 208, 255], [165, 196, 255]], true);
  environmentCache.nearStars = generateStarField(rng, Math.max(130, Math.floor((worldWidth + worldHeight) / 28)), [0.6, 0.85], [1.8, 2.8], [[255, 255, 255], [239, 245, 255], [222, 234, 255]], true);
}

function createSeededRng(seed) {
  const str = String(seed || 'seed');
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    const t = (h ^= h >>> 16) >>> 0;
    return t / 4294967296;
  };
}

function generateStarField(rng, count, parallaxRange, sizeRange, palette, withSparkle = false) {
  const [pMin, pMax] = Array.isArray(parallaxRange) ? parallaxRange : [parallaxRange, parallaxRange];
  const [sMin, sMax] = sizeRange;
  const paletteArray = Array.isArray(palette) && palette.length ? palette : [[255, 255, 255]];
  const stars = [];
  const worldWidth = Math.max(1, world?.width || 6000);
  const worldHeight = Math.max(1, world?.height || 5200);
  for (let i = 0; i < count; i++) {
    const colorTarget = paletteArray[Math.floor(rng() * paletteArray.length)] || [255, 255, 255];
    const alpha = 0.45 + rng() * 0.45;
    stars.push({
      x: rng() * worldWidth,
      y: rng() * worldHeight,
      parallax: pMin + rng() * (pMax - pMin),
      size: sMin + rng() * (sMax - sMin),
      color: `rgba(${colorTarget[0]}, ${colorTarget[1]}, ${colorTarget[2]}, ${alpha.toFixed(3)})`,
      sparkle: withSparkle && rng() > 0.7
    });
  }
  return stars;
}

function generateNebulas(rng, count) {
  const nebulas = [];
  const worldWidth = Math.max(1, world?.width || 6000);
  const worldHeight = Math.max(1, world?.height || 5200);
  for (let i = 0; i < count; i++) {
    const radius = 160 + rng() * 260;
    const size = Math.ceil(radius * 2);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const gctx = canvas.getContext('2d');
    const hue = 210 + rng() * 60;
    const gradient = gctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
    gradient.addColorStop(0, `hsla(${hue}, 75%, 65%, 0.18)`);
    gradient.addColorStop(0.5, `hsla(${hue}, 70%, 50%, 0.08)`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    gctx.fillStyle = gradient;
    gctx.fillRect(0, 0, size, size);
    nebulas.push({
      x: rng() * worldWidth,
      y: rng() * worldHeight,
      parallax: 0.12 + rng() * 0.12,
      alpha: 0.35 + rng() * 0.25,
      size,
      canvas
    });
  }
  return nebulas;
}

function generateBackgroundCanvas(rng, targetWidth, targetHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const gctx = canvas.getContext('2d');
  const radius = Math.max(targetWidth, targetHeight);
  const gradient = gctx.createRadialGradient(targetWidth / 2, targetHeight / 2, 0, targetWidth / 2, targetHeight / 2, radius);
  gradient.addColorStop(0, '#060b19');
  gradient.addColorStop(0.55, '#040814');
  gradient.addColorStop(1, '#02040a');
  gctx.fillStyle = gradient;
  gctx.fillRect(0, 0, targetWidth, targetHeight);

  const noiseCount = Math.floor((targetWidth * targetHeight) / 5500);
  for (let i = 0; i < noiseCount; i++) {
    const nx = rng() * targetWidth;
    const ny = rng() * targetHeight;
    const alpha = 0.05 + rng() * 0.08;
    gctx.fillStyle = `rgba(137, 180, 250, ${alpha.toFixed(3)})`;
    gctx.fillRect(nx, ny, 1, 1);
  }
  return canvas;
}

function warmupHudCache() {
  ctx.save();
  ctx.font = 'bold 28px ui-sans-serif, system-ui';
  ctx.measureText('Space Sonar .io');
  ctx.restore();
}

function waitNextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function delay(ms = 0) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runMatchLoadingSequence(matchData = {}) {
  if (!loadingOverlay) {
    prepareEnvironmentCache(matchData && matchData.id ? `match-${matchData.id}` : 'match');
    return;
  }

  if (isMatchLoading) {
    prepareEnvironmentCache(matchData && matchData.id ? `match-${matchData.id}` : 'match');
    return;
  }

  const seed = matchData && matchData.id ? `match-${matchData.id}` : `match-${Date.now()}`;
  showLoadingScreen('Harita yükleniyor...', 8, 'Uzay koordinatları hesaplanıyor...');
  try {
    await waitNextFrame();
    updateLoadingProgress(32, 'Uzay ortamı çiziliyor...');
    updateLoadingSubtext('Yıldız alanı önbelleğe alınıyor...');
    await waitNextFrame();
    prepareEnvironmentCache(seed);
    updateLoadingProgress(66, 'Çevresel detaylar hazırlanıyor...');
    updateLoadingSubtext('HUD bileşenleri optimize ediliyor...');
    warmupHudCache();
    await waitNextFrame();
    updateLoadingProgress(88, 'Sistemler senkronize ediliyor...');
    updateLoadingSubtext('Pilot verileri bekleniyor...');
    loadingSequenceReady = true;
    await delay(280);
  } catch (error) {
    hideLoadingScreen(true);
    throw error;
  }
  hideLoadingScreen();
}

// Toast notification system
function showToast(title, message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-title">${title}</div>
    <div class="toast-message">${message}</div>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease-out';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// add toastOut animation
const style = document.createElement('style');
style.textContent = '@keyframes toastOut { to { transform: translateX(120%); opacity: 0; } }';
document.head.appendChild(style);
const WEAPON_COSTS = { cannon: [100, 200, 300], torpedo: [150, 300, 500], missile: [200, 400, 700] };
const ELECTRONICS_COSTS = { radar: [120, 250, 400], sonar: [100, 200, 350], targeting: [180, 350, 600] };
const RANKED_UNLOCK_MATCHES = 5;

// UI visibility toggles
let showLeaderboard = true;
let showColorPicker = true;
let showMinimap = true;

// input state
const keys = new Set();
let turn = 0; // -1..1
let thrust = false;
let lastSent = 0;
let latency = 0;
let lastPingAt = performance.now();
let mouseX = 0;
let mouseY = 0;
let mouseDown = false;
let mouseRightDown = false;
const TURN_RATE = Math.PI * 1.4; // server turn speed (rad/s)
let localAngle = 0;
let localAngleInitialized = false;
let lastInputUpdateAt = null;
let spaceDown = false;

const FIRE_COOLDOWN = 500; // ms
let lastFireAt = 0;

// Audio Context for sound effects
let audioContext = null;
let audioUnlocked = false;

function unlockAudio() {
  if (audioUnlocked) return;
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    audioContext.resume();
    audioUnlocked = true;
  } catch (e) {
    // silent fail
  }
}

function playFireSound() {
  if (!audioContext || !audioUnlocked || !soundEnabled) return;
  try {
    const now = audioContext.currentTime;
    
    // Deep space cannon - bass + punch
    const osc1 = audioContext.createOscillator();
    const gain1 = audioContext.createGain();
    osc1.connect(gain1);
    gain1.connect(audioContext.destination);
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(120, now);
    osc1.frequency.exponentialRampToValueAtTime(60, now + 0.15);
    gain1.gain.setValueAtTime(0.4, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    osc1.start(now);
    osc1.stop(now + 0.15);
    
    // High frequency crack
    const osc2 = audioContext.createOscillator();
    const gain2 = audioContext.createGain();
    osc2.connect(gain2);
    gain2.connect(audioContext.destination);
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(2000, now);
    osc2.frequency.exponentialRampToValueAtTime(100, now + 0.05);
    gain2.gain.setValueAtTime(0.2, now);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
    osc2.start(now);
    osc2.stop(now + 0.05);
    
    // Noise burst for impact
    const bufferSize = audioContext.sampleRate * 0.03;
    const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / bufferSize * 10);
    }
    const noise = audioContext.createBufferSource();
    const noiseGain = audioContext.createGain();
    noise.buffer = buffer;
    noise.connect(noiseGain);
    noiseGain.connect(audioContext.destination);
    noiseGain.gain.setValueAtTime(0.3, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.03);
    noise.start(now);
  } catch (e) {
    // silent fail
  }
}

function playExplosionSound() {
  if (!audioContext || !audioUnlocked || !soundEnabled) return;
  try {
    const now = audioContext.currentTime;
    
    // Explosion bass
    const osc1 = audioContext.createOscillator();
    const gain1 = audioContext.createGain();
    osc1.connect(gain1);
    gain1.connect(audioContext.destination);
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(150, now);
    osc1.frequency.exponentialRampToValueAtTime(40, now + 0.3);
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc1.start(now);
    osc1.stop(now + 0.3);
    
    // Noise burst
    const bufferSize = audioContext.sampleRate * 0.2;
    const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / bufferSize * 8);
    }
    const noise = audioContext.createBufferSource();
    const noiseGain = audioContext.createGain();
    noise.buffer = buffer;
    noise.connect(noiseGain);
    noiseGain.connect(audioContext.destination);
    noiseGain.gain.setValueAtTime(0.25, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    noise.start(now);
  } catch (e) {
    // silent fail
  }
}

function playStreakSound(streak) {
  if (!audioContext || !audioUnlocked || !soundEnabled) return;
  try {
    const now = audioContext.currentTime;
    const baseFreq = 400 + (streak * 50);
    
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.type = 'sine';
    
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, now + 0.15);
    
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    
    osc.start(now);
    osc.stop(now + 0.15);
  } catch (e) {
    // silent fail
  }
}

function playHitSound() {
  if (!audioContext || !audioUnlocked || !soundEnabled) return;
  try {
    const now = audioContext.currentTime;
    
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.type = 'triangle';
    
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.08);
    
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
    
    osc.start(now);
    osc.stop(now + 0.08);
  } catch (e) {
    // silent fail
  }
}

const nameEl = document.getElementById('name');
const pingEl = document.getElementById('ping');
const fpsEl = document.getElementById('fps');
const cdBar = document.getElementById('cdbar');
const cdText = document.getElementById('cdtext');

const loginUsernameInput = document.getElementById('login-username');
const loginPasswordInput = document.getElementById('login-password');
const loginSubmitBtn = document.getElementById('login-submit');
const openRegisterBtn = document.getElementById('open-register');
const registerCard = document.getElementById('register-card');
const registerUsernameInput = document.getElementById('register-username');
const registerPasswordInput = document.getElementById('register-password');
const registerConfirmInput = document.getElementById('register-password-confirm');
const registerSubmitBtn = document.getElementById('register-submit');
const registerCancelBtn = document.getElementById('register-cancel');
const registerStatusEl = document.getElementById('register-status');
const playButtonsContainer = document.getElementById('play-buttons');
const queueNormalJoinBtn = document.getElementById('queue-normal-join');
const queueNormalLeaveBtn = document.getElementById('queue-normal-leave');
const queueRankedJoinBtn = document.getElementById('queue-ranked-join');
const queueRankedLeaveBtn = document.getElementById('queue-ranked-leave');
const queueNormalStatusEl = document.getElementById('queue-status-normal');
const queueRankedStatusEl = document.getElementById('queue-status-ranked');
const queueInfoEl = document.getElementById('queue-info');
const soundToggleBtn = document.getElementById('sound-toggle');
const rankedRequirementEl = document.getElementById('ranked-requirement');
const loginCard = document.getElementById('login-card');
const profileCard = document.getElementById('profile-card');
const profileUsernameEl = document.getElementById('profile-username');
const profileRankedNoteEl = document.getElementById('profile-ranked-note');
const logoutBtn = document.getElementById('logout-btn');
const careerStatsGrid = document.getElementById('career-stats-grid');
const careerCurrentRankEl = document.getElementById('career-current-rank');
const careerRankDetailEl = document.getElementById('career-rank-detail');
const careerModeCanvas = document.getElementById('career-mode-canvas');
const careerModeLegend = document.getElementById('career-mode-legend');
const careerRankCanvas = document.getElementById('career-rank-canvas');
const careerHistoryFooter = document.getElementById('career-history-footer');
const careerModeChartEl = document.getElementById('career-mode-chart');
const careerRankChartEl = document.getElementById('career-rank-chart');

// Server-side account system
let currentUser = null;
let isAuthenticated = false;

async function loginUser(username, password) {
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'Giriş başarısız');
    }
    
    currentUser = data.user;
    // save credentials locally for auto-login
    localStorage.setItem('space-sonar-creds', JSON.stringify({ username, password }));
    return data.user;
  } catch (error) {
    throw error;
  }
}

async function registerUser(username, password) {
  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'Kayıt başarısız');
    }
    
    currentUser = data.user;
    // save credentials locally
    localStorage.setItem('space-sonar-creds', JSON.stringify({ username, password }));
    return data.user;
  } catch (error) {
    throw error;
  }
}

async function updateUserProgress(username, updates) {
  try {
    await fetch('/api/user/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, updates })
    });
  } catch (error) {
    console.log('Progress update failed:', error);
  }
}

// Load persistent data
function loadProgress() {
  if (currentUser) {
    return {
      totalKills: currentUser.totalKills || 0,
      totalScore: currentUser.totalScore || 0,
      bestStreak: currentUser.bestStreak || 0,
      totalDeaths: currentUser.totalDeaths || 0,
      shipColor: currentUser.shipColor || '#ffffff',
      normalMatches: currentUser.normalMatches || 0,
      rankPoints: currentUser.rankPoints || 0,
      rankLabel: currentUser.rankLabel || currentUser.highestRankLabel || 'Demir 1',
      highestRankPoints: currentUser.highestRankPoints || 0,
      highestRankLabel: currentUser.highestRankLabel || currentUser.rankLabel || 'Demir 1',
      level: currentUser.level || 1,
      xp: currentUser.xp || 0,
      credits: currentUser.credits || 0,
      skills: { ...DEFAULT_SKILLS, ...(currentUser.skills || {}) },
      weapons: { ...DEFAULT_WEAPONS, ...(currentUser.weapons || {}) }
    };
  }
  return {
    totalKills: 0,
    totalScore: 0,
    bestStreak: 0,
    totalDeaths: 0,
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
  };
}

function saveProgress(data) {
  if (currentUser) {
    currentUser.totalKills = data.totalKills || currentUser.totalKills;
    currentUser.totalScore = data.totalScore || currentUser.totalScore;
    currentUser.bestStreak = data.bestStreak || currentUser.bestStreak;
    currentUser.shipColor = data.shipColor || currentUser.shipColor;
    if (typeof data.totalDeaths === 'number') {
      currentUser.totalDeaths = data.totalDeaths;
    }
    if (typeof data.normalMatches === 'number') {
      currentUser.normalMatches = data.normalMatches;
    }
    if (typeof data.rankPoints === 'number') {
      currentUser.rankPoints = data.rankPoints;
    }
    if (data.rankLabel) {
      currentUser.rankLabel = data.rankLabel;
    }
    if (typeof data.highestRankPoints === 'number') {
      currentUser.highestRankPoints = data.highestRankPoints;
    }
    if (data.highestRankLabel) {
      currentUser.highestRankLabel = data.highestRankLabel;
    }
    if (typeof data.level === 'number') {
      currentUser.level = data.level;
    }
    if (typeof data.xp === 'number') {
      currentUser.xp = data.xp;
    }
    if (typeof data.credits === 'number') {
      currentUser.credits = data.credits;
    }
    if (data.skills) {
      currentUser.skills = { ...DEFAULT_SKILLS, ...data.skills };
    }
    if (data.weapons) {
      currentUser.weapons = { ...DEFAULT_WEAPONS, ...data.weapons };
    }
    updateRankedRequirementDisplay();
    const payload = {
      totalKills: currentUser.totalKills || 0,
      totalScore: currentUser.totalScore || 0,
      bestStreak: currentUser.bestStreak || 0,
      totalDeaths: currentUser.totalDeaths || 0,
      shipColor: currentUser.shipColor || '#ffffff',
      normalMatches: currentUser.normalMatches || 0,
      rankPoints: currentUser.rankPoints || 0,
      rankLabel: currentUser.rankLabel || currentUser.highestRankLabel || 'Demir 1',
      highestRankPoints: currentUser.highestRankPoints || 0,
      highestRankLabel: currentUser.highestRankLabel || currentUser.rankLabel || 'Demir 1',
      level: currentUser.level || 1,
      xp: currentUser.xp || 0,
      credits: currentUser.credits || 0,
      skills: { ...DEFAULT_SKILLS, ...(currentUser.skills || {}) },
      weapons: { ...DEFAULT_WEAPONS, ...(currentUser.weapons || {}) }
    };
    updateUserProgress(currentUser.username, payload);
  }
}

// Show main menu on load
window.addEventListener('DOMContentLoaded', () => {
  setPlayButtonsEnabled(false);
  showMainMenu();
  
  if (loginSubmitBtn) loginSubmitBtn.addEventListener('click', (e) => {
    e.preventDefault();
    handleLogin();
  });
  if (loginUsernameInput) {
    loginUsernameInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (loginPasswordInput) loginPasswordInput.focus();
      }
    });
  }
  if (loginPasswordInput) {
    loginPasswordInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleLogin();
      }
    });
  }

  if (openRegisterBtn) openRegisterBtn.addEventListener('click', (e) => {
    e.preventDefault();
    showRegisterCard();
  });
  if (registerCancelBtn) registerCancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    hideRegisterCard();
  });
  if (registerSubmitBtn) registerSubmitBtn.addEventListener('click', (e) => {
    e.preventDefault();
    handleRegister();
  });
  if (registerConfirmInput) {
    registerConfirmInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRegister();
      }
    });
  }
  
  const careerButton = document.getElementById('career-button');
  const careerOverlay = document.getElementById('career-overlay');
  const careerClose = document.getElementById('career-close');
  if (careerButton) careerButton.addEventListener('click', showCareerOverlay);
  if (careerClose) careerClose.addEventListener('click', hideCareerOverlay);
  if (careerOverlay) {
    careerOverlay.addEventListener('click', (e) => {
      if (e.target === careerOverlay) hideCareerOverlay();
    });
  }
  document.querySelectorAll('.career-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-filter') || 'all';
      setCareerFilter(value);
    });
  });
  if (matchSummaryPlayAgainBtn) matchSummaryPlayAgainBtn.addEventListener('click', requestMatchRestart);
  if (matchSummaryExitBtn) matchSummaryExitBtn.addEventListener('click', returnToMainMenu);
  if (rankedLeaveCancelBtn) rankedLeaveCancelBtn.addEventListener('click', () => hideRankedLeaveOverlay());
  if (rankedLeaveCloseBtn) rankedLeaveCloseBtn.addEventListener('click', () => hideRankedLeaveOverlay());
  if (rankedLeaveConfirmBtn) rankedLeaveConfirmBtn.addEventListener('click', confirmRankedLeave);
  if (rankedLeaveOverlay) {
    rankedLeaveOverlay.addEventListener('click', (e) => {
      if (e.target === rankedLeaveOverlay && rankedLeaveOverlayVisible && !rankedLeaveRequestPending) {
        hideRankedLeaveOverlay();
      }
    });
  }
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
  if (queueNormalJoinBtn) queueNormalJoinBtn.addEventListener('click', () => joinQueue('normal'));
  if (queueNormalLeaveBtn) queueNormalLeaveBtn.addEventListener('click', leaveQueue);
  if (queueRankedJoinBtn) queueRankedJoinBtn.addEventListener('click', () => joinQueue('ranked'));
  if (queueRankedLeaveBtn) queueRankedLeaveBtn.addEventListener('click', leaveQueue);
});

function connectSocket() {
  if (gameStarted) return;
  if (!isAuthenticated || !currentUser) {
    updateAccountStatus('❌ Önce giriş yapmalısın.', 'error');
    return;
  }
  gameStarted = true;
  updateAccountStatus('⏳ Lobiye bağlanılıyor...', 'info');

  if (bgMusic && musicEnabled) {
    bgMusic.volume = 0.3;
    bgMusic.play().catch(e => console.log('Music autoplay blocked'));
  }

  setTimeout(() => {
    socket.connect();
  }, 300);
}

socket.on('connect', () => {
  lastPingAt = performance.now();
  
  const progress = loadProgress();
  const playerName = currentUser ? currentUser.username : `Guest-${Math.random().toString(36).slice(2, 8)}`;
  
  socket.emit('join', {
    name: playerName,
    persistentData: progress,
    mode: selectedMode
  });
});

socket.on('init', data => {
  myId = data.id;
  world = data.world;
  myName = data.name;
  availableColors = data.availableColors || [];
  nameEl.textContent = myName;
  teamMeta = data.teamMeta || {};
  myTeam = data.team || null;
  if (data.match) {
    const countdown = Math.max(0, data.match.countdown ?? 0);
    const previousPlayers = Array.isArray(matchInfo?.players) ? matchInfo.players : [];
    matchInfo = {
      id: data.match.id ?? matchInfo?.id,
      countdown,
      timeRemaining: Math.max(0, data.match.timeRemaining ?? 0),
      phase: data.match.phase || (countdown > 0 ? 'countdown' : 'active'),
      teams: data.match.teams || {},
      players: previousPlayers
    };
  }
  if (scoreboardVisible) renderScoreboard();
  const envSeed = data.match && data.match.id ? `match-${data.match.id}` : 'menu';
  prepareEnvironmentCache(envSeed);
});

socket.on('saveProgress', (data) => {
  saveProgress(data);
});

socket.on('streak', (data) => {
  streakNotifications.push({
    text: `${data.streak}x STREAK! ${data.bonus > 0 ? `+${data.bonus} bonus!` : ''}`,
    createdAt: performance.now()
  });
  playStreakSound(data.streak);
});

socket.on('state', s => {
  // ping estimate
  const now = performance.now();
  latency = Math.round(now - lastPingAt);
  pingEl.textContent = String(latency);
  lastPingAt = now;

  if (isMatchLoading && loadingSequenceReady) {
    hideLoadingScreen();
  }

  const seenIds = new Set();

  if (s.match) {
    const previousPlayers = Array.isArray(matchInfo?.players) ? matchInfo.players : [];
    const preserveEnd = matchInfo?.phase === 'ended';
    const countdown = Math.max(0, s.match.countdown ?? 0);
    matchInfo = {
      id: s.match.id ?? matchInfo.id,
      countdown,
      timeRemaining: Math.max(0, s.match.timeRemaining ?? matchInfo.timeRemaining ?? 0),
      phase: s.match.phase || (countdown > 0 ? 'countdown' : 'active'),
      teams: s.match.teams || matchInfo.teams || {},
      players: previousPlayers
    };
    if (matchInfo.phase === 'active') {
      matchInfo.players = [];
    }
  }

  // check for HP changes to show damage & update player snapshots
  for (const snapshot of s.players || []) {
    seenIds.add(snapshot.id);

    const oldHP = previousPlayerHP.get(snapshot.id);
    if (oldHP !== undefined && oldHP > snapshot.hp) {
      const damage = Math.round(oldHP - snapshot.hp);
      damageIndicators.push({
        x: snapshot.x,
        y: snapshot.y,
        damage,
        createdAt: now
      });

      // reduced hit particles (3 instead of 5)
      for (let i = 0; i < 3; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 100;
        particles.push({
          x: snapshot.x,
          y: snapshot.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0.2,
          maxLife: 0.2,
          color: '#ff4444',
          size: 2
        });
      }

      if (snapshot.id === myId) {
        playHitSound();
      }
    }
    previousPlayerHP.set(snapshot.id, snapshot.hp);

    let entry = players.get(snapshot.id);
    if (!entry) {
      entry = {
        id: snapshot.id,
        renderX: snapshot.x,
        renderY: snapshot.y,
        targetX: snapshot.x,
        targetY: snapshot.y,
        prevX: snapshot.x,
        prevY: snapshot.y,
        renderAngle: snapshot.angle,
        prevAngle: snapshot.angle,
        targetAngle: snapshot.angle,
        lastSnapshot: now,
        magnetic: snapshot.magnetic || 0,
        team: snapshot.team,
        teamColor: snapshot.teamColor,
        assists: snapshot.assists || 0,
        rankLabel: snapshot.rank || null,
        rankPoints: snapshot.rankPoints || 0,
        mode: snapshot.mode || 'normal',
        isRanked: snapshot.isRanked
      };
      players.set(snapshot.id, entry);
    } else {
      entry.prevX = entry.x ?? entry.renderX ?? snapshot.x;
      entry.prevY = entry.y ?? entry.renderY ?? snapshot.y;
      entry.prevAngle = entry.angle ?? entry.renderAngle ?? snapshot.angle;
      entry.targetX = snapshot.x;
      entry.targetY = snapshot.y;
      entry.targetAngle = snapshot.angle;
      entry.lastSnapshot = now;
    }

    entry.serverX = snapshot.x;
    entry.serverY = snapshot.y;
    entry.serverAngle = snapshot.angle;
    entry.vx = snapshot.vx;
    entry.vy = snapshot.vy;
    entry.name = snapshot.name;
    entry.hp = snapshot.hp;
    entry.maxHp = snapshot.maxHp;
    entry.isBot = snapshot.isBot;
    entry.score = snapshot.score;
    entry.kills = snapshot.kills;
    entry.deaths = snapshot.deaths;
    entry.assists = snapshot.assists || 0;
    entry.level = snapshot.level;
    entry.xp = snapshot.xp;
    entry.credits = snapshot.credits;
    entry.skills = snapshot.skills;
    entry.shipColor = snapshot.shipColor;
    entry.killStreak = snapshot.killStreak;
    entry.bestStreak = snapshot.bestStreak;
    entry.weapons = snapshot.weapons;
    entry.team = snapshot.team;
    entry.teamColor = snapshot.teamColor;
    entry.normalMatches = snapshot.normalMatches ?? entry.normalMatches ?? 0;
    entry.rankLabel = snapshot.rank || null;
    entry.rankPoints = snapshot.rankPoints || 0;
    entry.mode = snapshot.mode || entry.mode || 'normal';
    entry.isRanked = snapshot.isRanked;
    const targetMagnetic = snapshot.magnetic || 0;
    if (entry.magnetic === undefined) {
      entry.magnetic = targetMagnetic;
    } else {
      entry.magnetic = lerp(entry.magnetic, targetMagnetic, 0.4);
    }
    if (snapshot.id === myId) {
      myTeam = snapshot.team || myTeam;
      myMode = snapshot.mode || myMode;
      entry.rankLabel = snapshot.rank || entry.rankLabel;
      entry.rankPoints = typeof snapshot.rankPoints === 'number' ? snapshot.rankPoints : entry.rankPoints;
      entry.isRanked = snapshot.isRanked;
      if (typeof snapshot.normalMatches === 'number' && currentUser) {
        const prevMatches = currentUser.normalMatches || 0;
        if (snapshot.normalMatches !== prevMatches) {
          currentUser.normalMatches = snapshot.normalMatches;
          updateRankedRequirementDisplay();
        }
      }
      const serverAngle = snapshot.angle;
      if (Number.isFinite(serverAngle)) {
        if (!localAngleInitialized) {
          localAngle = serverAngle;
          localAngleInitialized = true;
        } else {
          localAngle = normalizeAngle(lerpAngle(localAngle, serverAngle, 0.2));
        }
      }
    }
  }

  for (const id of Array.from(players.keys())) {
    if (!seenIds.has(id)) {
      players.delete(id);
      previousPlayerHP.delete(id);
    }
  }

  bullets = s.bullets || [];
  projectiles = s.projectiles || [];
  killFeed = s.killFeed || [];

  updateKillFeed();
  updateUpgradeUI();
  renderCareerProgress();
  if (scoreboardVisible) {
    renderScoreboard();
  }
});

socket.on('explosion', (data) => {
  explosions.push({
    x: data.x,
    y: data.y,
    createdAt: performance.now(),
    size: 0
  });
  
  // reduced explosion particles (10 instead of 25)
  for (let i = 0; i < 10; i++) {
    const angle = (Math.PI * 2 * i) / 10;
    const speed = 150 + Math.random() * 150;
    particles.push({
      x: data.x,
      y: data.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.5,
      maxLife: 0.5,
      color: i % 2 === 0 ? '#ff6600' : '#ffaa00',
      size: 3
    });
  }
  
  playExplosionSound();
});

socket.on('matchStart', data => {
  localAngleInitialized = false;
  lastInputUpdateAt = null;
  hideRankedLeaveOverlay(true);
  hideMatchSummary();
  summaryRestartPending = false;
  queueState.mode = null;
  updateQueueUI();
  hideMainMenu();
  if (data && data.mode) {
    myMode = data.mode;
  }
  if (matchSummaryPlayAgainBtn) {
    matchSummaryPlayAgainBtn.disabled = false;
    matchSummaryPlayAgainBtn.textContent = 'Yeni Maça Başla';
  }
  const countdown = Math.max(0, data.countdown ?? MATCH_COUNTDOWN_MS);
  const timeRemaining = data.endsAt ? Math.max(0, data.endsAt - Date.now()) : MATCH_LENGTH_MS;
  matchInfo = {
    id: data.id,
    countdown,
    timeRemaining,
    phase: data.phase || (countdown > 0 ? 'countdown' : 'active'),
    teams: data.teams || matchInfo?.teams || {},
    players: []
  };
  if (scoreboardVisible) renderScoreboard();
  const message = countdown > 0 ? `Maç ${formatTime(countdown)} sonra başlayacak!` : 'Maç başladı!';
  showToast('Maç Başlıyor', message, 'info');
  Promise.resolve(runMatchLoadingSequence(data)).catch(err => console.error('match loading sequence failed', err));
});

socket.on('rankedLocked', data => {
  const required = data && typeof data.required === 'number' ? data.required : RANKED_UNLOCK_MATCHES;
  const current = data && typeof data.current === 'number' ? data.current : getNormalMatchesPlayed();
  if (currentUser) {
    currentUser.normalMatches = current;
  }
  gameStarted = false;
  updateRankedRequirementDisplay();
  updateAccountStatus(`❌ Ranked maç açmak için ${required} normal maç tamamlamalısın. (${current}/${required})`, 'error');
});

socket.on('matchEnd', data => {
  hideLoadingScreen(true);
  matchInfo = {
    id: data.id,
    countdown: 0,
    timeRemaining: 0,
    phase: 'ended',
    teams: data.teams || matchInfo?.teams || {},
    players: data.players || []
  };
  showMainMenu();
  updateQueueUI();
  if (scoreboardVisible) renderScoreboard();
  let message;
  if (!data || !data.winner || data.winner === 'draw') {
    message = 'Maç berabere bitti.';
  } else {
    const meta = teamMeta[data.winner];
    message = `${meta?.name || 'Kazanan takım'} galip geldi!`;
  }
  showToast('Maç Bitti', message, 'info');
  const meSummary = Array.isArray(data.players) ? data.players.find(p => p.id === myId) : null;
  if (meSummary && !meSummary.isBot) {
    const teamId = meSummary.team || myTeam;
    let result = 'draw';
    if (data.winner && data.winner !== 'draw' && teamId) {
      result = data.winner === teamId ? 'win' : 'loss';
    }
    addCareerEntry({
      matchId: data.id,
      endedAt: data.endedAt || Date.now(),
      mode: meSummary.mode || myMode,
      result,
      kills: meSummary.kills ?? 0,
      deaths: meSummary.deaths ?? 0,
      assists: meSummary.assists ?? 0,
      score: meSummary.score ?? 0,
      credits: meSummary.credits ?? 0,
      rank: typeof meSummary.rank === 'string' ? meSummary.rank : (meSummary.rank?.label || null),
      rankPoints: typeof meSummary.rank === 'object' && typeof meSummary.rank.points === 'number' ? meSummary.rank.points : (meSummary.rankPoints ?? 0),
      rankDelta: typeof meSummary.rankDelta === 'number' ? meSummary.rankDelta : 0,
      teamId,
      winner: data.winner
    });
  }
  const meSummaryForToast = Array.isArray(data.players) ? data.players.find(p => p.id === myId) : null;
  if (meSummaryForToast && meSummaryForToast.rank && myMode === 'ranked') {
    showToast('Rank Güncellendi', `${typeof meSummaryForToast.rank === 'string' ? meSummaryForToast.rank : meSummaryForToast.rank.label} ${meSummaryForToast.rankPoints ? `(${meSummaryForToast.rankPoints} RP)` : ''}`, 'success');
  }
  showMatchSummary(data);
});

socket.on('ranked:forfeit:result', (data = {}) => {
  rankedLeaveRequestPending = false;
  if (rankedLeaveConfirmBtn) {
    rankedLeaveConfirmBtn.disabled = false;
    rankedLeaveConfirmBtn.textContent = rankedLeaveConfirmDefaultText;
  }
  if (rankedLeaveCancelBtn) {
    rankedLeaveCancelBtn.disabled = false;
  }

  if (!data.success) {
    const message = data.error || 'Ranked maçtan ayrılırken bir hata oluştu. Lütfen tekrar dene.';
    showToast('Ranked Uyarısı', message, 'error');
    return;
  }

  hideRankedLeaveOverlay(true);

  const penalty = typeof data.penalty === 'number' ? data.penalty : RANKED_FORFEIT_PENALTY;
  if (currentUser) {
    if (typeof data.rankPoints === 'number') {
      currentUser.rankPoints = data.rankPoints;
    }
    if (data.rankLabel) {
      currentUser.rankLabel = data.rankLabel;
    }
    if (typeof data.highestRankPoints === 'number') {
      currentUser.highestRankPoints = Math.max(currentUser.highestRankPoints || 0, data.highestRankPoints);
    }
    if (data.highestRankLabel) {
      currentUser.highestRankLabel = data.highestRankLabel;
    }
    updateRankedRequirementDisplay();
  }

  showToast('Ranked Cezası', `Maçtan ayrıldığın için -${penalty} RP cezası uygulandı.`, 'warning');
  setTimeout(() => {
    returnToMainMenu();
  }, 350);
});

// controls
function onKey(e, down) {
  unlockAudio(); // unlock on any key press
  if (!e || typeof e.key !== 'string') return;
  if (e.key === 'Tab') {
    e.preventDefault();
    if (down) {
      showScoreboard();
    } else {
      hideScoreboard();
    }
    return;
  }
  if (e.key === 'Escape') {
    if (!down) return;
    e.preventDefault();
    if (rankedLeaveOverlayVisible) {
      hideRankedLeaveOverlay();
    } else if (scoreboardVisible) {
      hideScoreboard();
    } else if (canShowRankedLeaveOverlay()) {
      showRankedLeaveOverlay();
    }
    return;
  }
  const k = e.key.toLowerCase();
  keys[down ? 'add' : 'delete'](k);
  
  // Space for continuous fire
  if (k === ' ') {
    spaceDown = down;
  }
  
  // One-time actions
  if (down && !e.repeat) {
    if (k === 'g') fireTorpedo();
    if (k === 'h') fireMissile();
    if (k === '1') upgradeSkill('speedBoost');
    if (k === '2') upgradeSkill('shield');
    if (k === '3') upgradeSkill('rapidFire');
    if (k === 'f') toggleFullscreen();
    if (k === 'm') toggleMinimap();
  }
  
  updateInput();
}

function toggleMinimap() {
  showMinimap = !showMinimap;
}

function toggleFullscreen() {
  const doc = document;
  if (!doc.fullscreenElement) {
    const elem = doc.documentElement;
    if (elem.requestFullscreen) {
      elem.requestFullscreen().catch(() => {});
    }
  } else {
    if (doc.exitFullscreen) {
      doc.exitFullscreen().catch(() => {});
    }
  }
}

// global functions for HTML button clicks
window.upgradeSkill = function(skillName) {
  socket.emit('upgradeSkill', skillName);
};

window.upgradeWeapon = function(weaponName) {
  socket.emit('upgradeWeapon', weaponName);
};


function fireTorpedo() {
  const meData = players.get(myId);
  if (!meData || meData.weapons.torpedo === 0) return;
  socket.emit('fireTorpedo', {});
}

function fireMissile() {
  const meData = players.get(myId);
  if (!meData || meData.weapons.missile === 0) return;
  socket.emit('fireMissile', {});
}


// mouse down/up for fire (left) and rotation (right)
canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  unlockAudio();
  
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
  
  if (e.button === 0) {
    // left click - fire
    mouseDown = true;
  } else if (e.button === 2) {
    // right click - rotate
    mouseRightDown = true;
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    mouseDown = false;
  } else if (e.button === 2) {
    mouseRightDown = false;
  }
});

// prevent context menu on right click
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

// update mouse position on move
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
});

function pushNeutralInput() {
  if (socket && socket.connected) {
    socket.emit('input', { thrust: false, turn: 0 });
  }
}

function canShowRankedLeaveOverlay() {
  if (!gameStarted) return false;
  if (myMode !== 'ranked') return false;
  if (!matchInfo) return false;
  const phase = matchInfo.phase || 'waiting';
  return phase === 'countdown' || phase === 'active';
}

function updateRankedLeavePenaltyDisplay() {
  if (rankedLeavePenaltyEl) {
    rankedLeavePenaltyEl.textContent = `-${RANKED_FORFEIT_PENALTY} RP`;
  }
}

function showRankedLeaveOverlay() {
  if (!rankedLeaveOverlay || rankedLeaveRequestPending) return;
  if (!canShowRankedLeaveOverlay()) {
    showToast('Ranked Uyarısı', 'Yalnızca aktif ranked maçlarında ayrılma menüsü kullanılabilir.', 'warning');
    return;
  }
  updateRankedLeavePenaltyDisplay();
  rankedLeaveOverlay.classList.remove('hidden');
  rankedLeaveOverlayVisible = true;
  hideScoreboard();
  keys.clear();
  mouseDown = false;
  mouseRightDown = false;
  thrust = false;
  turn = 0;
  lastInputUpdateAt = performance.now();
  pushNeutralInput();
}

function hideRankedLeaveOverlay(force = false) {
  if (!rankedLeaveOverlay) return;
  if (!rankedLeaveOverlayVisible && !rankedLeaveRequestPending) return;
  if (rankedLeaveRequestPending && !force) return;
  rankedLeaveOverlayVisible = false;
  rankedLeaveRequestPending = false;
  rankedLeaveOverlay.classList.add('hidden');
  if (rankedLeaveConfirmBtn) {
    rankedLeaveConfirmBtn.disabled = false;
    rankedLeaveConfirmBtn.textContent = rankedLeaveConfirmDefaultText;
  }
  if (rankedLeaveCancelBtn) {
    rankedLeaveCancelBtn.disabled = false;
  }
}

function confirmRankedLeave() {
  if (rankedLeaveRequestPending) return;
  if (!socket || !socket.connected) {
    showToast('Ranked Uyarısı', 'Sunucuya bağlı değilsin. Önce tekrar bağlanmalısın.', 'error');
    return;
  }
  if (!canShowRankedLeaveOverlay()) {
    hideRankedLeaveOverlay(true);
    showToast('Ranked Uyarısı', 'Şu anda maçtan ayrılma menüsü kullanılamıyor.', 'warning');
    return;
  }
  rankedLeaveRequestPending = true;
  if (rankedLeaveConfirmBtn) {
    rankedLeaveConfirmBtn.disabled = true;
    rankedLeaveConfirmBtn.textContent = 'Çıkılıyor...';
  }
  if (rankedLeaveCancelBtn) {
    rankedLeaveCancelBtn.disabled = true;
  }
  pushNeutralInput();
  socket.emit('ranked:forfeit', { penalty: RANKED_FORFEIT_PENALTY });
}

window.addEventListener('keydown', e => onKey(e, true));
window.addEventListener('keyup', e => onKey(e, false));
window.addEventListener('blur', hideScoreboard);

function updateInput() {
  const now = performance.now();
  if (lastInputUpdateAt === null) {
    lastInputUpdateAt = now;
  }
  const dt = Math.max(0, (now - lastInputUpdateAt) / 1000);
  lastInputUpdateAt = now;

  const serverMe = getMe();

  if (rankedLeaveOverlayVisible) {
    thrust = false;
    turn = 0;
    if (now - lastSent > 40) {
      socket.emit('input', { thrust, turn });
      lastSent = now;
    }
    return;
  }

  if (localAngleInitialized) {
    if (serverMe && Number.isFinite(serverMe.angle)) {
      localAngle = normalizeAngle(lerpAngle(localAngle, serverMe.angle, clamp01(dt * 3)));
    }
    localAngle = normalizeAngle(localAngle + turn * TURN_RATE * dt);
  } else if (serverMe && Number.isFinite(serverMe.angle)) {
    localAngle = serverMe.angle;
    localAngleInitialized = true;
  }

  const newThrust = keys.has('w') || keys.has('arrowup');
  let newTurn = 0;

  // mouse right click rotation (override keyboard)
  if (mouseRightDown) {
    const dx = mouseX - width / 2;
    const dy = mouseY - height / 2;
    const targetAngle = Math.atan2(dy, dx);
    const currentAngle = localAngleInitialized ? localAngle : (serverMe?.angle ?? 0);
    let angleDiff = normalizeAngle(targetAngle - currentAngle);

    const desiredDirection = angleDiff > 0 ? 1 : angleDiff < 0 ? -1 : 0;
    const previousDirection = Math.sign(turn);
    if (
      desiredDirection !== 0 &&
      previousDirection !== 0 &&
      desiredDirection !== previousDirection &&
      Math.abs(angleDiff) < 0.18
    ) {
      angleDiff = previousDirection * Math.abs(angleDiff);
    }

    const magnitude = clamp01(Math.abs(angleDiff) / 0.45);
    newTurn = desiredDirection * magnitude;

    if (Math.abs(angleDiff) < 0.06) {
      newTurn = 0;
    }
  }

  newTurn = Math.max(-1, Math.min(1, newTurn));

  thrust = newThrust;
  turn = newTurn;

  if (now - lastSent > 40) {
    socket.emit('input', { thrust, turn });
    lastSent = now;
  }
}

function triggerFire() {
  const now = performance.now();
  if (now - lastFireAt < FIRE_COOLDOWN) return;
  lastFireAt = now;
  playFireSound();
  socket.emit('fire'); // fire in ship's current direction
}

function triggerFireAtAngle(angle) {
  const now = performance.now();
  if (now - lastFireAt < FIRE_COOLDOWN) return;
  lastFireAt = now;
  playFireSound();
  socket.emit('fire', { angle: angle });
}

// camera follows me
function getMe() {
  return players.get(myId) || { x: world.width / 2, y: world.height / 2, angle: 0 };
}

// wrap-aware delta for drawing nearby entities
function wrappedDelta(ax, ay, bx, by) {
  let dx = ax - bx;
  let dy = ay - by;
  if (dx > world.width / 2) dx -= world.width;
  if (dx < -world.width / 2) dx += world.width;
  if (dy > world.height / 2) dy -= world.height;
  if (dy < -world.height / 2) dy += world.height;
  return { dx, dy };
}

function updatePlayerInterpolation() {
  const now = performance.now();
  players.forEach(player => {
    if (player.targetX === undefined || player.targetY === undefined) {
      const x = player.x ?? player.serverX ?? 0;
      const y = player.y ?? player.serverY ?? 0;
      const angle = player.angle ?? player.serverAngle ?? 0;
      player.renderX = x;
      player.renderY = y;
      player.renderAngle = angle;
      player.x = x;
      player.y = y;
      player.angle = angle;
      return;
    }

    const startX = player.prevX ?? player.targetX;
    const startY = player.prevY ?? player.targetY;
    const startAngle = player.prevAngle ?? player.targetAngle;
    const elapsed = Math.max(0, now - (player.lastSnapshot || now));
    const t = smoothStep(elapsed / SNAPSHOT_INTERVAL_MS);

    player.renderX = lerp(startX, player.targetX, t);
    player.renderY = lerp(startY, player.targetY, t);
    player.renderAngle = lerpAngle(startAngle, player.targetAngle, t);

    player.x = player.renderX;
    player.y = player.renderY;
    player.angle = player.renderAngle;
  });
}

// rendering
let lastFpsAt = performance.now();
let frames = 0;
function drawShip(x, y, angle, options = {}) {
  const {
    primary = '#00ff00', // lime green default
    accent = '#8ec5ff',
    scale = 1,
    thrusting = false,
    glow = true,
    magnetic = 0
  } = options;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);

  // Engine flames (simplified - no particles for performance)
  if (thrusting) {
    const flicker = 1 + Math.random() * 0.3;
    const flameLength = 20 * flicker;
    
    // Main engine flame (center) - no shadow for performance
    ctx.fillStyle = '#ff8800';
    ctx.beginPath();
    ctx.moveTo(-16, -5);
    ctx.lineTo(-16 - flameLength, -3);
    ctx.lineTo(-16 - flameLength * 0.5, 0);
    ctx.lineTo(-16 - flameLength, 3);
    ctx.lineTo(-16, 5);
    ctx.closePath();
    ctx.fill();
  }

  // Nose cone (red pointed tip)
  ctx.fillStyle = '#a23b3b';
  ctx.beginPath();
  ctx.moveTo(22, 0);
  ctx.lineTo(14, -6);
  ctx.lineTo(14, 6);
  ctx.closePath();
  ctx.fill();

  // Main body (lime green rocket)
  ctx.fillStyle = primary;
  ctx.beginPath();
  ctx.moveTo(14, -6);
  ctx.lineTo(14, 6);
  ctx.lineTo(-10, 6);
  ctx.lineTo(-10, -6);
  ctx.closePath();
  ctx.fill();

  // Window/cockpit (blue-gray geometric)
  ctx.fillStyle = '#5a7a8a';
  ctx.beginPath();
  ctx.moveTo(10, -4);
  ctx.lineTo(6, -2);
  ctx.lineTo(6, 2);
  ctx.lineTo(10, 4);
  ctx.closePath();
  ctx.fill();

  // Window highlight
  ctx.fillStyle = '#7a9aaa';
  ctx.beginPath();
  ctx.moveTo(10, -3);
  ctx.lineTo(7, -1);
  ctx.lineTo(7, 1);
  ctx.lineTo(10, 3);
  ctx.closePath();
  ctx.fill();

  // Side wings (red swept back)
  ctx.fillStyle = '#a23b3b';
  // Left wing
  ctx.beginPath();
  ctx.moveTo(2, -6);
  ctx.lineTo(2, -14);
  ctx.lineTo(-8, -14);
  ctx.lineTo(-8, -6);
  ctx.closePath();
  ctx.fill();
  // Right wing
  ctx.beginPath();
  ctx.moveTo(2, 6);
  ctx.lineTo(2, 14);
  ctx.lineTo(-8, 14);
  ctx.lineTo(-8, 6);
  ctx.closePath();
  ctx.fill();

  // Wing details (green on wings)
  ctx.fillStyle = primary;
  ctx.fillRect(0, -12, 3, 5);
  ctx.fillRect(0, 7, 3, 5);

  // Side boosters (green cylinders)
  ctx.fillStyle = primary;
  ctx.fillRect(-10, -16, 4, 10);
  ctx.fillRect(-10, 6, 4, 10);

  // Booster tips (red)
  ctx.fillStyle = '#a23b3b';
  ctx.beginPath();
  ctx.moveTo(-10, -16);
  ctx.lineTo(-8, -18);
  ctx.lineTo(-6, -16);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-10, 16);
  ctx.lineTo(-8, 18);
  ctx.lineTo(-6, 16);
  ctx.closePath();
  ctx.fill();

  // Booster stripes (red bands)
  ctx.fillStyle = '#8b2f2f';
  ctx.fillRect(-10, -8, 4, 2);
  ctx.fillRect(-10, 14, 4, 2);

  // Engine base (red block)
  ctx.fillStyle = '#a23b3b';
  ctx.fillRect(-16, -6, 6, 12);

  // Engine nozzles (dark)
  ctx.fillStyle = '#3a1f1f';
  ctx.fillRect(-16, -4, 2, 3);
  ctx.fillRect(-16, 1, 2, 3);

  ctx.restore();
}

function drawDarkness(me) {
  // light darkness layer - ships should be visible
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, width, height);

  // large vision cone around me adjusted for oval world
  const inner = 100;
  const outer = 600;
  const grad = ctx.createRadialGradient(width/2, height/2, inner, width/2, height/2, outer);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.2)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(width/2, height/2, outer, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}


function drawBullets(me) {
  for (const bullet of bullets) {
    const { dx, dy } = wrappedDelta(bullet.x, bullet.y, me.x, me.y);
    const bx = width/2 + dx;
    const by = height/2 + dy;
    
    // tracking bullets have different color
    if (bullet.targetId) {
      ctx.shadowColor = '#ff4444';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#ff6666';
    } else {
      ctx.shadowColor = '#ffaa44';
      ctx.shadowBlur = 15;
      ctx.fillStyle = '#fff4d6';
    }
    
    ctx.beginPath();
    ctx.arc(bx, by, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawTargetLockIndicator(me) {
  // targeting system removed
  return;
  
  // find target in front of ship
  const maxDist = 800 + (meData.electronics.targeting * 200);
  const coneAngle = Math.PI / 3 - (meData.electronics.targeting * 0.15);
  
  let nearestTarget = null;
  let minDist = Infinity;
  
  for (const other of players.values()) {
    if (other.id === myId || other.hp <= 0) continue;
    const { dx, dy } = wrappedDelta(other.x, other.y, me.x, me.y);
    const dist = Math.hypot(dx, dy);
    if (dist > maxDist) continue;
    
    const angleToTarget = Math.atan2(dy, dx);
    let angleDiff = angleToTarget - me.angle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    
    if (Math.abs(angleDiff) < coneAngle && dist < minDist) {
      minDist = dist;
      nearestTarget = other;
    }
  }
  
  if (nearestTarget) {
    const { dx, dy } = wrappedDelta(nearestTarget.x, nearestTarget.y, me.x, me.y);
    const tx = width/2 + dx;
    const ty = height/2 + dy;
    
    // animated lock brackets
    const time = performance.now() * 0.003;
    const pulse = Math.sin(time * 3) * 0.3 + 0.7;
    
    ctx.strokeStyle = `rgba(255, 0, 0, ${pulse})`;
    ctx.lineWidth = 3;
    const bracketSize = 25;
    
    // top-left
    ctx.beginPath();
    ctx.moveTo(tx - bracketSize, ty - bracketSize);
    ctx.lineTo(tx - bracketSize, ty - bracketSize + 10);
    ctx.moveTo(tx - bracketSize, ty - bracketSize);
    ctx.lineTo(tx - bracketSize + 10, ty - bracketSize);
    ctx.stroke();
    
    // top-right
    ctx.beginPath();
    ctx.moveTo(tx + bracketSize, ty - bracketSize);
    ctx.lineTo(tx + bracketSize, ty - bracketSize + 10);
    ctx.moveTo(tx + bracketSize, ty - bracketSize);
    ctx.lineTo(tx + bracketSize - 10, ty - bracketSize);
    ctx.stroke();
    
    // bottom-left
    ctx.beginPath();
    ctx.moveTo(tx - bracketSize, ty + bracketSize);
    ctx.lineTo(tx - bracketSize, ty + bracketSize - 10);
    ctx.moveTo(tx - bracketSize, ty + bracketSize);
    ctx.lineTo(tx - bracketSize + 10, ty + bracketSize);
    ctx.stroke();
    
    // bottom-right
    ctx.beginPath();
    ctx.moveTo(tx + bracketSize, ty + bracketSize);
    ctx.lineTo(tx + bracketSize, ty + bracketSize - 10);
    ctx.moveTo(tx + bracketSize, ty + bracketSize);
    ctx.lineTo(tx + bracketSize - 10, ty + bracketSize);
    ctx.stroke();
    
    // "LOCKED" text
    ctx.font = 'bold 10px ui-sans-serif, system-ui';
    ctx.fillStyle = `rgba(255, 0, 0, ${pulse})`;
    ctx.textAlign = 'center';
    ctx.fillText('LOCKED', tx, ty - bracketSize - 8);
  }
}

function drawProjectiles(me) {
  for (const proj of projectiles) {
    const { dx, dy } = wrappedDelta(proj.x, proj.y, me.x, me.y);
    const px = width/2 + dx;
    const py = height/2 + dy;
    
    if (proj.type === 'torpedo') {
      // torpedo - blue streak
      ctx.shadowColor = '#4080ff';
      ctx.shadowBlur = 20;
      ctx.fillStyle = '#5090ff';
      ctx.beginPath();
      ctx.ellipse(px, py, 12, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    } else if (proj.type === 'missile') {
      // missile - red with flame trail
      ctx.shadowColor = '#ff4444';
      ctx.shadowBlur = 25;
      ctx.fillStyle = '#ff6666';
      ctx.beginPath();
      ctx.ellipse(px, py, 14, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      // flame trail
      ctx.fillStyle = '#ff8800';
      ctx.beginPath();
      ctx.arc(px - 10, py, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}

function updateAndDrawParticles(me, now) {
  const dt = 1/60;
  
  // update and draw particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.98; // slight drag
    p.vy *= 0.98;
    
    const { dx, dy } = wrappedDelta(p.x, p.y, me.x, me.y);
    const px = width/2 + dx;
    const py = height/2 + dy;
    
    const alpha = p.life / p.maxLife;
    ctx.fillStyle = p.color;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(px, py, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  
  // draw damage indicators
  const DAMAGE_DURATION = 1000;
  for (let i = damageIndicators.length - 1; i >= 0; i--) {
    const ind = damageIndicators[i];
    const age = now - ind.createdAt;
    
    if (age > DAMAGE_DURATION) {
      damageIndicators.splice(i, 1);
      continue;
    }
    
    const { dx, dy } = wrappedDelta(ind.x, ind.y, me.x, me.y);
    const ix = width/2 + dx;
    const iy = height/2 + dy - (age / DAMAGE_DURATION) * 40;
    
    const alpha = 1 - (age / DAMAGE_DURATION);
    ctx.font = 'bold 18px ui-sans-serif, system-ui';
    ctx.fillStyle = `rgba(255, 68, 68, ${alpha})`;
    ctx.strokeStyle = `rgba(0, 0, 0, ${alpha})`;
    ctx.lineWidth = 3;
    ctx.textAlign = 'center';
    ctx.strokeText(`-${ind.damage}`, ix, iy);
    ctx.fillText(`-${ind.damage}`, ix, iy);
  }
}

function drawExplosions(me, now) {
  const EXPLOSION_DURATION = 500; // ms
  
  for (let i = explosions.length - 1; i >= 0; i--) {
    const exp = explosions[i];
    const age = now - exp.createdAt;
    
    if (age > EXPLOSION_DURATION) {
      explosions.splice(i, 1);
      continue;
    }
    
    const { dx, dy } = wrappedDelta(exp.x, exp.y, me.x, me.y);
    const ex = width/2 + dx;
    const ey = height/2 + dy;
    
    const progress = age / EXPLOSION_DURATION;
    const size = 80 * (1 - Math.pow(1 - progress, 2));
    const alpha = 1 - progress;
    
    // outer ring
    ctx.strokeStyle = `rgba(255, 100, 50, ${alpha})`;
    ctx.lineWidth = 8 * (1 - progress);
    ctx.beginPath();
    ctx.arc(ex, ey, size, 0, Math.PI * 2);
    ctx.stroke();
    
    // middle ring
    ctx.strokeStyle = `rgba(255, 180, 50, ${alpha * 0.8})`;
    ctx.lineWidth = 6 * (1 - progress);
    ctx.beginPath();
    ctx.arc(ex, ey, size * 0.7, 0, Math.PI * 2);
    ctx.stroke();
    
    // inner flash
    if (progress < 0.3) {
      ctx.fillStyle = `rgba(255, 255, 200, ${(1 - progress / 0.3) * 0.8})`;
      ctx.beginPath();
      ctx.arc(ex, ey, size * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    
    // particles
    for (let p = 0; p < 8; p++) {
      const angle = (p / 8) * Math.PI * 2;
      const dist = size * 0.9;
      const px = ex + Math.cos(angle) * dist;
      const py = ey + Math.sin(angle) * dist;
      ctx.fillStyle = `rgba(255, 150, 50, ${alpha * 0.6})`;
      ctx.beginPath();
      ctx.arc(px, py, 4 * (1 - progress), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawMiniMap(me, now) {
  const pad = 12;
  const baseSize = Math.min(220, Math.floor(width * 0.22));
  const mapWidth = baseSize;
  const mapHeight = Math.round(baseSize * 0.72);
  const x0 = width - pad - mapWidth;
  const y0 = pad + 8;
  const cx = x0 + mapWidth / 2;
  const cy = y0 + mapHeight / 2;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, mapWidth / 2, mapHeight / 2, 0, 0, TAU);
  ctx.fillStyle = '#0b0e14';
  ctx.fill();
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.clip();

  const innerPad = 10;
  const sx = x0 + innerPad;
  const sy = y0 + innerPad;
  const sw = mapWidth - innerPad * 2;
  const sh = mapHeight - innerPad * 2;

  const scaleX = sw / world.width;
  const scaleY = sh / world.height;

  // other players
  for (const p of players.values()) {
    const px = sx + p.x * scaleX;
    const py = sy + p.y * scaleY;
    if (p.id === myId) continue;
    const isEnemy = myTeam && p.team && myTeam !== p.team;
    const baseColor = isEnemy ? '#ff4d6d' : '#89b4fa';
    const radius = isEnemy ? 5 : 3;
    if (isEnemy) {
      ctx.shadowColor = 'rgba(255,77,109,0.8)';
      ctx.shadowBlur = 12;
    }
    ctx.fillStyle = baseColor;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
    if (isEnemy) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,77,109,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, radius + 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // me (triangle)
  const mx = sx + me.x * scaleX;
  const my = sy + me.y * scaleY;
  ctx.save();
  ctx.translate(mx, my);
  ctx.rotate(me.angle);
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.lineTo(-6, -5);
  ctx.lineTo(-3, 0);
  ctx.lineTo(-6, 5);
  ctx.closePath();
  ctx.fillStyle = '#cdd6f4';
  ctx.fill();
  ctx.restore();

  ctx.restore();

  // label
  ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('MAP', x0 + 8, y0 - 4);
}

function drawReveals(me, now) {
  // reveal other ships if nearby (sonar removed)
  for (const other of players.values()) {
    if (other.id === myId) continue;
    
    // check if nearby (within vision range)
    const { dx: vdx, dy: vdy } = wrappedDelta(other.x, other.y, me.x, me.y);
    const distFromMe = Math.hypot(vdx, vdy);
    if (distFromMe > 600) continue; // visible range increased to 600
    
    const { dx, dy } = wrappedDelta(other.x, other.y, me.x, me.y);
    const ox = width/2 + dx;
    const oy = height/2 + dy;
    
    // draw ship with their custom color
    const enemyColor = other.shipColor || '#ff6666';
    const shipColor = { primary: enemyColor, accent: '#ffaaaa', scale: 1.05, glow: true, magnetic: other.magnetic || 0 };
    drawShip(ox, oy, other.angle, shipColor);
    
    // draw name and HP
    ctx.save();
    ctx.font = '12px ui-sans-serif, system-ui';
    ctx.fillStyle = '#ff6666';
    ctx.textAlign = 'center';
    ctx.fillText(other.name, ox, oy - 30);
    
    // HP bar mini
    const barW = 50;
    const barH = 5;
    const hpRatio = other.hp / other.maxHp;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(ox - barW/2, oy - 22, barW, barH);
    const hpColor = hpRatio > 0.6 ? '#a6e3a1' : hpRatio > 0.3 ? '#f9e2af' : '#f38ba8';
    ctx.fillStyle = hpColor;
    ctx.fillRect(ox - barW/2 + 1, oy - 21, (barW - 2) * hpRatio, barH - 2);
    ctx.restore();
  }
}

function drawStars(me) {
  const seed = matchInfo && matchInfo.id ? `match-${matchInfo.id}` : 'menu';
  ensureEnvironmentCache(seed);

  if (environmentCache.background) {
    ctx.drawImage(environmentCache.background, 0, 0, width, height);
  } else {
    ctx.fillStyle = '#020308';
    ctx.fillRect(0, 0, width, height);
  }

  const originX = width / 2;
  const originY = height / 2;

  if (environmentCache.nebulas && environmentCache.nebulas.length) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < environmentCache.nebulas.length; i++) {
      const neb = environmentCache.nebulas[i];
      const { dx, dy } = wrappedDelta(neb.x, neb.y, me.x, me.y);
      const px = originX + dx * neb.parallax;
      const py = originY + dy * neb.parallax;
      ctx.globalAlpha = neb.alpha;
      ctx.drawImage(neb.canvas, px - neb.size / 2, py - neb.size / 2, neb.size, neb.size);
    }
    ctx.restore();
  }

  drawStarLayer(environmentCache.farStars, me, originX, originY, false);
  drawStarLayer(environmentCache.midStars, me, originX, originY, false);
  drawStarLayer(environmentCache.nearStars, me, originX, originY, true);
}

function drawStarLayer(layer, me, originX, originY, allowSparkle) {
  if (!Array.isArray(layer) || !layer.length) return;
  for (let i = 0; i < layer.length; i++) {
    const star = layer[i];
    const { dx, dy } = wrappedDelta(star.x, star.y, me.x, me.y);
    const px = originX + dx * star.parallax;
    const py = originY + dy * star.parallax;
    if (px < -60 || px > width + 60 || py < -60 || py > height + 60) continue;
    ctx.fillStyle = star.color;
    ctx.fillRect(px - star.size / 2, py - star.size / 2, star.size, star.size);
    if (allowSparkle && star.sparkle) {
      const sparkleSize = Math.max(1.4, star.size + 0.8);
      ctx.fillRect(px - sparkleSize / 2, py - 0.5, sparkleSize, 1);
      ctx.fillRect(px - 0.5, py - sparkleSize / 2, 1, sparkleSize);
    }
  }
}

function drawHPBar(me, now) {
  const meData = players.get(myId);
  if (!meData) return;

  const barW = 300;
  const barH = 28;
  const x = (width - barW) / 2;
  const y = height - 80;

  // background
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(x, y, barW, barH);

  // HP fill
  const hpRatio = meData.hp / meData.maxHp;
  const fillW = (barW - 4) * hpRatio;
  const hpColor = hpRatio > 0.6 ? '#a6e3a1' : hpRatio > 0.3 ? '#f9e2af' : '#f38ba8';
  ctx.fillStyle = hpColor;
  ctx.fillRect(x + 2, y + 2, fillW, barH - 4);

  // border
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, barW, barH);

  // text
  ctx.font = '14px ui-sans-serif, system-ui';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(`HP: ${Math.ceil(meData.hp)} / ${meData.maxHp}`, x + barW / 2, y + barH / 2 + 5);

  // XP bar
  const xpBarW = 300;
  const xpBarH = 8;
  const xpX = (width - xpBarW) / 2;
  const xpY = height - 48;
  const xpForNext = meData.level * 100;
  const xpRatio = meData.xp / xpForNext;
  
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(xpX, xpY, xpBarW, xpBarH);
  ctx.fillStyle = '#fab387';
  ctx.fillRect(xpX + 1, xpY + 1, (xpBarW - 2) * xpRatio, xpBarH - 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(xpX, xpY, xpBarW, xpBarH);

  // stats
  ctx.font = 'bold 16px ui-sans-serif, system-ui';
  ctx.fillStyle = '#f9e2af';
  ctx.textAlign = 'left';
  ctx.fillText(`Lv.${meData.level}`, 16, height - 100);
  
  // streak indicator
  if (meData.killStreak >= 2) {
    ctx.fillStyle = meData.killStreak >= 5 ? '#ff6b9d' : '#f9e2af';
    ctx.fillText(`🔥 ${meData.killStreak}x STREAK`, 16, height - 80);
  }
  
  ctx.fillStyle = '#a6e3a1';
  ctx.fillText(`💵 ${meData.credits}`, 16, height - 58);
  ctx.fillStyle = '#89b4fa';
  ctx.fillText(`⭐ ${meData.score}`, 16, height - 36);
  ctx.fillStyle = '#f38ba8';
  ctx.fillText(`💀 ${meData.kills}/${meData.deaths}`, 16, height - 14);

  ctx.textAlign = 'left';
  
  // update skill levels
  updateSkillUI(meData);
  
  // draw streak notifications
  drawStreakNotifications(now);
}

function drawStreakNotifications(now) {
  const NOTIF_DURATION = 2000;

  for (let i = streakNotifications.length - 1; i >= 0; i--) {
    const notif = streakNotifications[i];
    const age = now - notif.createdAt;

    if (age > NOTIF_DURATION) {
      streakNotifications.splice(i, 1);
      continue;
    }

    const progress = age / NOTIF_DURATION;
    const alpha = 1 - progress;
    const y = height / 2 - 100 - (progress * 50);

    ctx.save();
    ctx.font = 'bold 28px ui-sans-serif, system-ui';
    ctx.fillStyle = `rgba(255, 215, 0, ${alpha})`;
    ctx.strokeStyle = `rgba(255, 100, 50, ${alpha})`;
    ctx.lineWidth = 4;
    ctx.textAlign = 'center';
    ctx.shadowColor = `rgba(255, 150, 0, ${alpha})`;
    ctx.shadowBlur = 20;
    ctx.strokeText(notif.text, width / 2, y);
    ctx.fillText(notif.text, width / 2, y);
    ctx.restore();
  }
}

function updateKillFeed() {
  const feed = document.getElementById('killfeed');
  if (!feed) return;
  
  // only update if changed
  const currentHash = JSON.stringify(killFeed);
  if (currentHash === lastKillFeedUpdate) return;
  lastKillFeedUpdate = currentHash;
  
  feed.innerHTML = killFeed.map(kill => {
    const streakText = kill.streak >= 3 ? ` <span style="color: #f9e2af;">🔥${kill.streak}x</span>` : '';
    return `<div class="kill-item">
      <span class="killer">${kill.killer}</span> 💥 <span class="killed">${kill.killed}</span>${streakText}
    </div>`;
  }).join('');
}

function updateSkillUI(meData) {
  const speedLevel = document.getElementById('speed-level');
  const shieldLevel = document.getElementById('shield-level');
  const rapidLevel = document.getElementById('rapid-level');
  
  const speedCost = SKILL_COSTS.speedBoost[meData.skills.speedBoost] || 'MAX';
  const shieldCost = SKILL_COSTS.shield[meData.skills.shield] || 'MAX';
  const rapidCost = SKILL_COSTS.rapidFire[meData.skills.rapidFire] || 'MAX';
  
  if (speedLevel) speedLevel.textContent = `Lv. ${meData.skills.speedBoost}/3 (${speedCost})`;
  if (shieldLevel) shieldLevel.textContent = `Lv. ${meData.skills.shield}/3 (${shieldCost})`;
  if (rapidLevel) rapidLevel.textContent = `Lv. ${meData.skills.rapidFire}/3 (${rapidCost})`;
  
  // Update affordability glow
  updateAffordabilityGlow(meData);
}

function updateAffordabilityGlow(meData) {
  const credits = meData.credits || 0;
  
  // Skills
  const skillSpeed = document.getElementById('skill-speed');
  const skillShield = document.getElementById('skill-shield');
  const skillRapid = document.getElementById('skill-rapid');
  
  const speedCost = SKILL_COSTS.speedBoost[meData.skills.speedBoost];
  const shieldCost = SKILL_COSTS.shield[meData.skills.shield];
  const rapidCost = SKILL_COSTS.rapidFire[meData.skills.rapidFire];
  
  updateAffordableGlowClass(skillSpeed, credits >= speedCost && speedCost !== undefined);
  updateAffordableGlowClass(skillShield, credits >= shieldCost && shieldCost !== undefined);
  updateAffordableGlowClass(skillRapid, credits >= rapidCost && rapidCost !== undefined);
  
  // Weapons
  const weaponItems = document.querySelectorAll('.upgrade-item');
  if (weaponItems.length >= 3) {
    const cannonCost = WEAPON_COSTS.cannon[meData.weapons.cannon];
    const torpedoCost = WEAPON_COSTS.torpedo[meData.weapons.torpedo];
    const missileCost = WEAPON_COSTS.missile[meData.weapons.missile];
    
    updateAffordableGlowClass(weaponItems[0], credits >= cannonCost && cannonCost !== undefined);
    updateAffordableGlowClass(weaponItems[1], credits >= torpedoCost && torpedoCost !== undefined);
    updateAffordableGlowClass(weaponItems[2], credits >= missileCost && missileCost !== undefined);
  }
}

function updateAffordableGlowClass(element, canAfford) {
  if (!element) return;
  if (canAfford) {
    element.classList.add('affordable');
  } else {
    element.classList.remove('affordable');
  }
}

function updateUpgradeUI() {
  const meData = players.get(myId);
  if (!meData) return;
  
  // weapons only (electronics removed)
  const cannonLevel = document.getElementById('cannon-level');
  const torpedoLevel = document.getElementById('torpedo-level');
  const missileLevel = document.getElementById('missile-level');
  
  if (!meData.weapons) return; // safety check
  
  const cannonCost = WEAPON_COSTS.cannon[meData.weapons.cannon] || 'MAX';
  const torpedoCost = WEAPON_COSTS.torpedo[meData.weapons.torpedo] || 'MAX';
  const missileCost = WEAPON_COSTS.missile[meData.weapons.missile] || 'MAX';
  
  if (cannonLevel) cannonLevel.textContent = `Lv. ${meData.weapons.cannon}/3 ${cannonCost !== 'MAX' ? `(${cannonCost})` : ''}`;
  if (torpedoLevel) torpedoLevel.textContent = `Lv. ${meData.weapons.torpedo}/3 ${torpedoCost !== 'MAX' ? `(${torpedoCost})` : ''}`;
  if (missileLevel) missileLevel.textContent = `Lv. ${meData.weapons.missile}/3 ${missileCost !== 'MAX' ? `(${missileCost})` : ''}`;
  
  // Update cooldown glow
  updateWeaponCooldownGlow();
}

function updateWeaponCooldownGlow() {
  const now = performance.now();
  const elapsed = now - lastFireAt;
  const cooldownRatio = Math.min(1, elapsed / FIRE_COOLDOWN);
  
  const weaponsPanel = document.getElementById('weapons-panel');
  if (!weaponsPanel) return;
  
  if (cooldownRatio >= 1) {
    // Ready - glow effect
    weaponsPanel.style.boxShadow = '0 0 20px rgba(137, 180, 250, 0.8), 0 0 40px rgba(137, 180, 250, 0.4)';
    weaponsPanel.style.borderColor = 'rgba(137, 180, 250, 0.8)';
  } else {
    // Cooling down - dim
    weaponsPanel.style.boxShadow = 'none';
    weaponsPanel.style.borderColor = 'rgba(248, 113, 113, 0.3)';
  }
}

function drawCrosshair() {
  if (mouseX === 0 && mouseY === 0) return;
  
  ctx.save();
  const size = 20;
  const gap = 8;
  
  // outer glow
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(mouseX - size, mouseY);
  ctx.lineTo(mouseX - gap, mouseY);
  ctx.moveTo(mouseX + gap, mouseY);
  ctx.lineTo(mouseX + size, mouseY);
  ctx.moveTo(mouseX, mouseY - size);
  ctx.lineTo(mouseX, mouseY - gap);
  ctx.moveTo(mouseX, mouseY + gap);
  ctx.lineTo(mouseX, mouseY + size);
  ctx.stroke();
  
  // inner crosshair
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mouseX - size, mouseY);
  ctx.lineTo(mouseX - gap, mouseY);
  ctx.moveTo(mouseX + gap, mouseY);
  ctx.lineTo(mouseX + size, mouseY);
  ctx.moveTo(mouseX, mouseY - size);
  ctx.lineTo(mouseX, mouseY - gap);
  ctx.moveTo(mouseX, mouseY + gap);
  ctx.lineTo(mouseX, mouseY + size);
  ctx.stroke();
  
  // center dot
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.beginPath();
  ctx.arc(mouseX, mouseY, 2, 0, Math.PI * 2);
  ctx.fill();
  
  ctx.restore();
}

function render() {
  if (isMatchLoading) {
    ctx.save();
    ctx.fillStyle = '#050810';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
    requestAnimationFrame(render);
    return;
  }
  updatePlayerInterpolation();
  updateInput();
  const me = getMe();
  const now = performance.now();

  // Update weapon cooldown glow every frame
  updateWeaponCooldownGlow();

  // Continuous fire when space or mouse held (with cooldown check)
  if (mouseDown && now - lastFireAt >= FIRE_COOLDOWN) {
    triggerFire();
  }

  // FPS counter
  frames++;
  if (now - lastFpsAt >= 1000) {
    fpsEl.textContent = String(frames);
    frames = 0;
    lastFpsAt = now;
  }

  // background
  drawStars(me);
  drawWorldBoundary(me);

  // world origin at center
  ctx.save();
  // draw my ship at center with custom color
  const meData = players.get(myId);
  const myColor = (meData && meData.shipColor) || '#00ff00';
  drawShip(width/2, height/2, me.angle, { primary: myColor, accent: '#cfe7ff', thrusting: thrust, magnetic: (meData && meData.magnetic) || 0 });

  // reveals (other ships)
  drawReveals(me, now);
  
  // target lock indicator
  drawTargetLockIndicator(me);
  
  // bullets
  drawBullets(me);
  
  // projectiles (torpedoes, missiles)
  drawProjectiles(me);
  
  // particles
  updateAndDrawParticles(me, now);
  
  // explosions
  drawExplosions(me, now);

  ctx.restore();

  // darkness on top, with small vision around me
  drawDarkness(me);

  // mini map on top-right (if visible)
  if (showMinimap) {
    drawMiniMap(me, now);
  }

  // HP bar and score
  drawHPBar(me, now);
  
  // crosshair
  drawCrosshair();

  drawMatchStatus();

  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// Draggable panels
function makeDraggable(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;

  const handle = panel.querySelector('.draggable-handle');
  if (!handle) return;

  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  handle.addEventListener('mousedown', (e) => {
    isDragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    panel.style.transition = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const x = e.clientX - offsetX;
    const y = e.clientY - offsetY;
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.bottom = 'auto';
    panel.style.transform = 'none';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      panel.style.transition = '';
    }
  });
}

makeDraggable('skills-panel');
makeDraggable('weapons-panel');

function drawWorldBoundary(me) {
  if (!world || !world.width || !world.height) return;
  const radiusX = world.width / 2;
  const radiusY = world.height / 2;
  const centerX = radiusX;
  const centerY = radiusY;
  const offsetX = centerX - me.x;
  const offsetY = centerY - me.y;

  ctx.save();
  ctx.translate(width / 2 + offsetX, height / 2 + offsetY);
  ctx.strokeStyle = 'rgba(255, 112, 112, 0.45)';
  ctx.lineWidth = 2;
  ctx.setLineDash([16, 10]);
  ctx.beginPath();
  ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  const dx = me.x - centerX;
  const dy = me.y - centerY;
  const normalized = (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY);
  if (normalized > 0.7) {
    const proximity = clamp01((normalized - 0.7) / 0.18);
    const grad = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.55);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(255, 90, 90, ${0.35 * proximity})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }
}

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatNumber(value) {
  const numeric = Number.isFinite(value) ? value : 0;
  return numberFormatter.format(Math.round(numeric));
}

function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  const str = String(value);
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, ch => map[ch] || ch);
}

function renderScoreboard() {
  if (!scoreboardVisible || !scoreboardOverlay || !scoreboardBody) return;
  const usingSummary = Array.isArray(matchInfo?.players) && matchInfo.players.length > 0 && matchInfo.phase !== 'active';
  const playerArray = usingSummary ? matchInfo.players : Array.from(players.values());
  const teams = matchInfo?.teams || {};

  const buildTeamSection = (teamId) => {
    const meta = teamMeta[teamId] || { name: teamId.toUpperCase(), color: teamId === 'red' ? '#ff5f5f' : '#5fb6ff' };
    const teamData = teams[teamId] || { score: 0, kills: 0, deaths: 0, assists: 0, count: 0 };
    const members = playerArray.filter(p => (p.team || teamId) === teamId);
    members.sort((a, b) => {
      const killsA = a.kills ?? 0;
      const killsB = b.kills ?? 0;
      if (killsB !== killsA) return killsB - killsA;

      const assistsA = a.assists ?? 0;
      const assistsB = b.assists ?? 0;
      if (assistsB !== assistsA) return assistsB - assistsA;

      const scoreA = a.score ?? 0;
      const scoreB = b.score ?? 0;
      if (scoreB !== scoreA) return scoreB - scoreA;

      const deathsA = a.deaths ?? 0;
      const deathsB = b.deaths ?? 0;
      return deathsA - deathsB;
    });
    const rows = members.length ? members.map(p => {
      const kills = p.kills ?? 0;
      const assists = p.assists ?? 0;
      const deaths = p.deaths ?? 0;
      const kda = ((kills + assists) / Math.max(1, deaths)).toFixed(2);
      const rankLabelRaw = typeof p.rank === 'string'
        ? p.rank
        : (p.rank && typeof p.rank === 'object' ? p.rank.label : (p.rankLabel || (p.isRanked ? 'Ranked' : 'Normal')));
      const rankPoints = typeof p.rank === 'object' && typeof p.rank.points === 'number'
        ? p.rank.points
        : (typeof p.rankPoints === 'number' ? p.rankPoints : 0);
      const rankDelta = typeof p.rankDelta === 'number' ? p.rankDelta : 0;
      const rankLabel = rankLabelRaw || (p.isRanked ? 'Ranked' : 'Normal');
      const rankTitle = rankPoints ? `${rankLabel} • ${rankPoints} RP${rankDelta ? ` (${rankDelta > 0 ? '+' : ''}${rankDelta} RP)` : ''}` : rankLabel;
      const rankIcon = getRankIcon(rankLabel);
      const credits = p.isBot ? '-' : Math.round(p.credits ?? 0);
      const color = p.teamColor || meta.color;
      const isMe = p.id === myId;
      const isBot = p.isBot ?? false;
      return `
        <div class="sb-row ${isMe ? 'sb-row-me' : ''}">
          <div class="sb-player" style="color:${color}">${p.name || 'Bilinmeyen'}${isBot ? '<span class="sb-bot">BOT</span>' : ''}</div>
          <div>${kills}</div>
          <div>${assists}</div>
          <div>${deaths}</div>
          <div>${kda}</div>
          <div title="${rankTitle}">${rankIcon} ${rankLabel}</div>
          <div>${p.score ?? 0}</div>
          <div>${credits}</div>
        </div>`;
    }).join('') : '<div class="sb-row sb-row-empty"><div>Oyuncu yok</div><div></div><div></div><div></div><div></div><div></div><div></div><div></div></div>';

    return `
      <div class="sb-team" style="border-color:${(teamData.color || meta.color || '#ffffff') + '33'}">
        <div class="sb-team-header" style="border-color:${(teamData.color || meta.color || '#ffffff') + '55'}">
          <div class="sb-team-name" style="color:${teamData.color || meta.color}">${teamData.name || meta.name}</div>
          <div class="sb-team-score">Skor: ${teamData.score ?? 0}</div>
          <div class="sb-team-meta">Kill: ${teamData.kills ?? 0} · Asist: ${teamData.assists ?? 0} · Ölüm: ${teamData.deaths ?? 0} · Oyuncu: ${teamData.count ?? members.length}</div>
        </div>
        <div class="sb-table">
          <div class="sb-row sb-row-head">
            <div>Oyuncu</div><div>K</div><div>A</div><div>Ö</div><div>KDA</div><div>Rank</div><div>Skor</div><div>💰</div>
          </div>
          ${rows}
        </div>
      </div>
    `;
  };

  const countdown = Math.max(0, matchInfo?.countdown ?? 0);
  const remaining = Math.max(0, matchInfo?.timeRemaining ?? 0);
  const myTeamLabel = myTeam && (teamMeta[myTeam]?.name || myTeam.toUpperCase());

  let titlePrefix;
  let timerText;
  if (matchInfo?.phase === 'ended') {
    titlePrefix = 'Maç Özeti';
    timerText = `Sonraki Maça ${formatTime(countdown || MATCH_COUNTDOWN_MS)}`;
  } else if (countdown > 0) {
    titlePrefix = 'Hazırlık';
    timerText = `Başlangıca ${formatTime(countdown)}`;
  } else {
    titlePrefix = myMode === 'ranked' ? 'Ranked Maç' : 'Maç';
    timerText = `Kalan Süre: ${formatTime(remaining)}`;
  }

  scoreboardOverlay.classList.add('visible');
  scoreboardBody.innerHTML = `
    <div class="sb-header">
      <div class="sb-title">${titlePrefix}${myTeamLabel ? ` · ${myTeamLabel}` : ''}</div>
      <div class="sb-timer">${timerText}</div>
      <div class="sb-hint">TAB tuşuna basılı tut</div>
    </div>
    <div class="sb-teams">
      ${buildTeamSection('red')}
      ${buildTeamSection('blue')}
    </div>
  `;
}

function showScoreboard() {
  if (scoreboardVisible) return;
  scoreboardVisible = true;
  if (scoreboardOverlay) {
    scoreboardOverlay.classList.add('visible');
  }
  renderScoreboard();
}

function hideScoreboard() {
  if (!scoreboardVisible) return;
  scoreboardVisible = false;
  if (scoreboardOverlay) {
    scoreboardOverlay.classList.remove('visible');
  }
}

function drawMatchStatus() {
  if (!gameStarted || !matchInfo) return;
  const phase = matchInfo.phase || 'active';
  let text = '';
  let color = '#89b4fa';
  if (phase === 'countdown') {
    const countdown = Math.max(0, matchInfo.countdown ?? 0);
    text = countdown > 0 ? `Maç ${formatTime(countdown)} sonra başlayacak` : 'Maç başlıyor';
    color = '#f9e2af';
  } else if (phase === 'active') {
    const timeRemaining = Math.max(0, matchInfo.timeRemaining ?? 0);
    text = `Kalan Süre: ${formatTime(timeRemaining)}`;
    color = '#89b4fa';
  } else if (phase === 'waiting') {
    text = 'Yeni maç için oyuncular bekleniyor';
    color = '#cdd6f4';
  } else {
    text = 'Maç sona erdi';
    color = '#cdd6f4';
  }
  if (!text) return;
  ctx.save();
  ctx.font = 'bold 18px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 10;
  ctx.fillText(text, width / 2, 60);
  ctx.restore();
}

const CAREER_KEY = 'space-sonar-career';

function loadCareerHistory() {
  try {
    const raw = localStorage.getItem(CAREER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveCareerHistory(entries) {
  try {
    localStorage.setItem(CAREER_KEY, JSON.stringify(entries.slice(0, 20)));
  } catch (err) {
    // ignore
  }
}

function addCareerEntry(entry) {
  const history = loadCareerHistory();
  history.unshift(entry);
  saveCareerHistory(history);
  renderCareerPanel();
  renderCareerProgress();
}

function formatDateTime(ts) {
  const date = new Date(ts);
  return `${date.toLocaleDateString('tr-TR')} · ${date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`;
}

function summarizeCareer(history) {
  const summary = { wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0, assists: 0, score: 0, credits: 0, normalMatches: 0, rankedMatches: 0 };
  for (const match of history) {
    if (match.result === 'win') summary.wins++;
    else if (match.result === 'loss') summary.losses++;
    else summary.draws++;
    summary.kills += match.kills || 0;
    summary.deaths += match.deaths || 0;
    summary.assists += match.assists || 0;
    summary.score += match.score || 0;
    summary.credits += match.credits || 0;
    if (match.mode === 'ranked') summary.rankedMatches++;
    else summary.normalMatches++;
  }
  const totalMatches = history.length || 1;
  summary.avgKDA = ((summary.kills + summary.assists) / Math.max(1, summary.deaths)).toFixed(2);
  summary.avgScore = totalMatches ? summary.score / totalMatches : 0;
  summary.avgCredits = totalMatches ? summary.credits / totalMatches : 0;
  summary.matches = history.length;
  return summary;
}

function updateCareerFilterButtons() {
  document.querySelectorAll('.career-filter').forEach(btn => {
    const filter = btn.getAttribute('data-filter') || 'all';
    btn.classList.toggle('active', filter === careerFilter);
  });
}

function renderCareerPanel() {
  const overlay = document.getElementById('career-overlay');
  const listEl = document.getElementById('career-list');
  const summaryEl = document.getElementById('career-summary');
  if (!overlay || !listEl || !summaryEl) return;
  const history = loadCareerHistory();
  const overallSummary = summarizeCareer(history);
  renderCareerOverview(history, overallSummary);
  renderModeChart(history);
  renderRankChart(history);
  if (careerHistoryFooter) {
    if (history.length) {
      const winRate = history.length ? (overallSummary.wins / history.length) * 100 : 0;
      careerHistoryFooter.textContent = `Toplam kayıt: ${history.length} · Galibiyet: ${overallSummary.wins} · Mağlubiyet: ${overallSummary.losses} · Beraberlik: ${overallSummary.draws} · Win % ${(winRate).toFixed(1)}`;
    } else {
      careerHistoryFooter.textContent = 'Henüz maç kaydı bulunmuyor.';
    }
  }
  const filtered = history.filter(entry => {
    if (careerFilter === 'all') return true;
    return (entry.mode || 'normal') === careerFilter;
  });
  const limited = filtered.slice(0, 10);
  if (limited.length === 0) {
    summaryEl.textContent = careerFilter === 'ranked' ? 'Ranked maç kaydı bulunamadı.' : careerFilter === 'normal' ? 'Normal maç kaydı bulunamadı.' : 'Henüz maç oynanmadı.';
    listEl.innerHTML = '<div class="career-empty">Kayıt bulunamadı.</div>';
  } else {
    const summary = summarizeCareer(limited);
    const label = careerFilter === 'ranked' ? 'Ranked' : careerFilter === 'normal' ? 'Normal' : 'Tüm';
    summaryEl.textContent = `${label} maçlardan ${limited.length} tanesi · Galibiyet: ${summary.wins} · Mağlubiyet: ${summary.losses} · Beraberlik: ${summary.draws} · Ortalama KDA: ${summary.avgKDA} · Ortalama Skor: ${Math.round(summary.avgScore)}`;
    listEl.innerHTML = limited.map(entry => {
      const resultLabel = entry.result === 'win' ? 'Galibiyet' : entry.result === 'loss' ? 'Mağlubiyet' : 'Berabere';
      const resultClass = entry.result === 'win' ? 'win' : entry.result === 'loss' ? 'loss' : 'draw';
      const modeLabel = entry.mode === 'ranked' ? 'Ranked' : 'Normal';
      const kda = `${entry.kills}/${entry.deaths}/${entry.assists}`;
      const rankText = entry.rank ? `${entry.rank}${entry.rankPoints ? ` · ${entry.rankPoints} RP` : ''}` : '-';
      const deltaText = entry.rankDelta ? `${entry.rankDelta > 0 ? '+' : ''}${entry.rankDelta} RP` : '';
      const icon = getRankIcon(entry.rank);
      const tooltip = entry.teamId && entry.winner ? `${entry.teamId === entry.winner ? 'Takım Kazandı' : 'Takım Kaybetti'}` : '';
      return `
        <div class="career-item ${resultClass}" title="${tooltip}">
          <div class="career-label">${formatDateTime(entry.endedAt)}</div>
          <div class="career-mode">${modeLabel}</div>
          <div class="career-result ${resultClass}">${resultLabel}</div>
          <div class="career-rank">${icon} ${rankText}${deltaText ? ` · ${deltaText}` : ''}</div>
          <div class="career-stats">K/D/A: ${kda}</div>
          <div class="career-stats">Skor: ${entry.score ?? 0} · 💰 ${entry.credits ?? 0}</div>
        </div>
      `;
    }).join('');
  }
  updateCareerFilterButtons();
}

function showCareerOverlay() {
  if (!isAuthenticated || !currentUser) {
    updateAccountStatus('❌ Giriş yaptıktan sonra kariyerini görüntüleyebilirsin.', 'error');
    return;
  }
  careerFilter = 'all';
  updateCareerFilterButtons();
  renderCareerPanel();
  renderCareerProgress();
  const overlay = document.getElementById('career-overlay');
  if (overlay) overlay.classList.add('visible');
}

function hideCareerOverlay() {
  const overlay = document.getElementById('career-overlay');
  if (overlay) overlay.classList.remove('visible');
}

function setCareerFilter(filter) {
  careerFilter = filter;
  updateCareerFilterButtons();
  renderCareerPanel();
}

const RANK_ICONS = {
  'Demir': '⛓️',
  'Bronz': '🥉',
  'Gümüş': '🥈',
  'Altın': '🥇',
  'Elmas': '💎',
  'Space': '🚀',
  'Normal': '🌌',
  'BOT': '🤖'
};

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

function getRankIcon(rankLabel) {
  if (!rankLabel || typeof rankLabel !== 'string') return '🌌';
  const normalized = rankLabel.split(' ')[0];
  return RANK_ICONS[normalized] || '🌌';
}

function renderRankLegend(container) {
  if (!container) return;
  const entries = Object.entries(RANK_ICONS).map(([tier, icon]) => {
    if (tier === 'BOT') return '';
    return `<div class="rank-icon">${icon}<span>${tier}</span></div>`;
  }).filter(Boolean).join('');
  container.innerHTML = entries;
}

function normalizeRankInfo(rankLabel, points) {
  if (!rankLabel) return { tier: 'Normal', level: null, points: points || 0 };
  const parts = rankLabel.split(' ');
  const tier = parts[0];
  const level = parts[1] ? parseInt(parts[1], 10) : null;
  return { tier, level: isNaN(level) ? null : level, points: points || 0 };
}

function calculateRankProgress(rankInfo) {
  const { tier, level, points } = rankInfo;
  const order = ['Demir', 'Bronz', 'Gümüş', 'Altın', 'Elmas', 'Space'];
  const tierIndex = order.indexOf(tier);
  if (tierIndex < 0) return { tier, level, points, current: points, next: points, progress: 1 };
  const tiers = RANK_TIERS.filter(t => t.tier === tier);
  if (tier === 'Space') {
    const base = tiers[0]?.min ?? 4200;
    const next = base + 500;
    return { tier, level: null, points, current: points - base, next: next - base, progress: Math.min(1, (points - base) / (next - base)) };
  }
  const levelIndex = Math.max(0, (level || 1) - 1);
  const currentTier = tiers[levelIndex];
  const nextTier = tiers[levelIndex + 1] || RANK_TIERS.find(t => t.tier === order[tierIndex + 1]);
  const currentMin = currentTier?.min ?? points;
  const nextMin = nextTier?.min ?? currentMin + 500;
  const total = nextMin - currentMin;
  const progress = Math.max(0, Math.min(1, (points - currentMin) / total));
  return { tier, level, points, current: points - currentMin, next: total, progress };
}

function renderCareerProgress() {
  const progressEl = document.getElementById('career-progress');
  if (!progressEl) return;

  let rankLabel = null;
  let rankPoints = 0;
  let isRanked = false;

  const me = players.get(myId);
  if (me && !me.isBot && me.isRanked && (me.rankLabel || me.rankInfo)) {
    rankLabel = typeof me.rankLabel === 'string' ? me.rankLabel : (me.rankInfo?.label || null);
    rankPoints = typeof me.rankPoints === 'number' ? me.rankPoints : (me.rankInfo?.points || 0);
    isRanked = true;
  }

  if (!rankLabel) {
    const history = loadCareerHistory();
    const rankedEntry = history.find(entry => entry.mode === 'ranked' && entry.rank);
    if (rankedEntry) {
      rankLabel = rankedEntry.rank;
      rankPoints = rankedEntry.rankPoints || 0;
      isRanked = true;
    }
  }

  if (!rankLabel) {
    progressEl.innerHTML = '<div class="career-progress-label">Henüz ranked maç tamamlanmadı.</div>';
    if (careerCurrentRankEl) careerCurrentRankEl.textContent = '-';
    if (careerRankDetailEl) careerRankDetailEl.textContent = 'Ranked maçlara katıldığında rütben burada gözükecek.';
    return;
  }

  const info = normalizeRankInfo(rankLabel, rankPoints);
  const progress = calculateRankProgress(info);
  const icon = getRankIcon(rankLabel);
  const label = `${rankLabel}${isRanked ? ` · ${rankPoints} RP` : ''}`;
  const footer = info.tier === 'Space'
    ? `${progress.current} RP (Space)`
    : `${progress.current}/${progress.next} RP`;

  progressEl.innerHTML = `
    <div class="career-progress-badge">${icon}<span>${label}</span></div>
    <div class="career-progress-bar">
      <div class="career-progress-fill" style="width:${Math.min(100, Math.round(progress.progress * 100))}%"></div>
    </div>
    <div class="career-progress-label">${footer}</div>
  `;
  if (careerCurrentRankEl) {
    careerCurrentRankEl.innerHTML = `${icon} ${label}`;
  }
  if (careerRankDetailEl) {
    const remaining = progress.next ? Math.max(0, Math.round(progress.next - progress.current)) : 0;
    const detail = info.tier === 'Space'
      ? `${rankPoints} RP · Maksimum rütbe`
      : `${rankPoints} RP · Sonraki aşamaya ${remaining} RP`; 
    careerRankDetailEl.textContent = detail;
  }
}

function renderCareerOverview(history, summary) {
  if (!careerStatsGrid) return;
  const summaryData = summary || summarizeCareer(history);
  const totalMatches = summaryData.matches ?? history.length;
  const totalKills = typeof currentUser?.totalKills === 'number' ? currentUser.totalKills : summaryData.kills ?? 0;
  const totalDeaths = typeof currentUser?.totalDeaths === 'number' ? currentUser.totalDeaths : summaryData.deaths ?? 0;
  const bestStreak = typeof currentUser?.bestStreak === 'number' ? currentUser.bestStreak : 0;
  const normalMatches = typeof currentUser?.normalMatches === 'number'
    ? currentUser.normalMatches
    : summaryData.normalMatches ?? history.filter(entry => entry.mode !== 'ranked').length;
  const rankedMatches = summaryData.rankedMatches ?? history.filter(entry => entry.mode === 'ranked').length;
  const winRate = totalMatches ? (summaryData.wins ?? 0) / totalMatches * 100 : 0;
  const avgScore = summaryData.avgScore ?? 0;
  const avgCredits = summaryData.avgCredits ?? 0;
  const kd = totalDeaths === 0 ? (totalKills > 0 ? totalKills : 0) : totalKills / totalDeaths;

  const cards = [
    { label: 'Toplam Kill', value: formatNumber(totalKills) },
    { label: 'Toplam Death', value: formatNumber(totalDeaths) },
    { label: 'K/D', value: kd.toFixed(2) },
    { label: 'En İyi Seri', value: formatNumber(bestStreak) },
    { label: 'Normal Maç', value: formatNumber(normalMatches) },
    { label: 'Ranked Maç', value: formatNumber(rankedMatches) },
    { label: 'Galibiyet %', value: `${winRate.toFixed(1)}%`, sub: `${summaryData.wins ?? 0}/${totalMatches || 0} galibiyet` },
    { label: 'Ortalama Skor', value: formatNumber(avgScore), sub: `Avg krediler ${formatNumber(avgCredits)}` }
  ];

  careerStatsGrid.innerHTML = cards.map(card => `
    <div class="career-stat-card">
      <span class="label">${card.label}</span>
      <span class="value">${card.value}</span>
      ${card.sub ? `<span class="sub">${card.sub}</span>` : ''}
    </div>
  `).join('');
}

function drawChartPlaceholder(ctx, text) {
  const canvas = ctx.canvas;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(205,214,244,0.6)';
  ctx.font = '14px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

function renderModeChart(history) {
  if (!careerModeCanvas || !careerModeCanvas.getContext) return;
  const ctx = careerModeCanvas.getContext('2d');
  const normal = history.filter(entry => entry.mode !== 'ranked').length;
  const ranked = history.filter(entry => entry.mode === 'ranked').length;
  const total = normal + ranked;
  if (careerModeLegend) {
    careerModeLegend.innerHTML = '';
  }
  if (!total) {
    drawChartPlaceholder(ctx, 'Veri yok');
    if (careerModeLegend) careerModeLegend.innerHTML = '<span>Veri yok</span>';
    return;
  }
  ctx.clearRect(0, 0, careerModeCanvas.width, careerModeCanvas.height);
  const cx = careerModeCanvas.width / 2;
  const cy = careerModeCanvas.height / 2;
  const radius = Math.min(cx, cy) - 12;
  let startAngle = -Math.PI / 2;
  const segments = [
    { value: normal, color: '#a6e3a1', label: 'Normal' },
    { value: ranked, color: '#89b4fa', label: 'Ranked' }
  ].filter(seg => seg.value > 0);
  segments.forEach(segment => {
    const angle = (segment.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.fillStyle = segment.color;
    ctx.arc(cx, cy, radius, startAngle, startAngle + angle, false);
    ctx.closePath();
    ctx.fill();
    startAngle += angle;
  });
  ctx.fillStyle = '#0f111b';
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#cdd6f4';
  ctx.font = '14px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${total} maç`, cx, cy);
  if (careerModeLegend) {
    careerModeLegend.innerHTML = segments.map(seg => {
      const percent = ((seg.value / total) * 100).toFixed(1);
      return `<span><span class="dot" style="background:${seg.color}"></span>${seg.label} (${seg.value}) · ${percent}%</span>`;
    }).join('');
  }
}

function renderRankChart(history) {
  if (!careerRankCanvas || !careerRankCanvas.getContext) return;
  const ctx = careerRankCanvas.getContext('2d');
  const width = careerRankCanvas.width;
  const height = careerRankCanvas.height;
  ctx.clearRect(0, 0, width, height);
  const rankedHistory = history
    .filter(entry => entry.mode === 'ranked' && typeof entry.rankPoints === 'number')
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  if (rankedHistory.length === 0) {
    drawChartPlaceholder(ctx, 'Rank verisi yok');
    return;
  }
  const padding = 28;
  const minRP = Math.min(...rankedHistory.map(entry => entry.rankPoints));
  const maxRP = Math.max(...rankedHistory.map(entry => entry.rankPoints));
  const range = Math.max(1, maxRP - minRP);
  const stepX = rankedHistory.length > 1 ? (width - padding * 2) / (rankedHistory.length - 1) : 0;
  ctx.strokeStyle = 'rgba(205,214,244,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, padding);
  ctx.lineTo(padding, height - padding);
  ctx.lineTo(width - padding, height - padding);
  ctx.stroke();
  ctx.strokeStyle = '#89b4fa';
  ctx.lineWidth = 2;
  ctx.beginPath();
  rankedHistory.forEach((entry, index) => {
    const x = padding + stepX * index;
    const y = height - padding - ((entry.rankPoints - minRP) / range) * (height - padding * 2);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#f38ba8';
  rankedHistory.forEach((entry, index) => {
    const x = padding + stepX * index;
    const y = height - padding - ((entry.rankPoints - minRP) / range) * (height - padding * 2);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = 'rgba(205,214,244,0.75)';
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.textAlign = 'left';
  ctx.fillText(`${minRP} RP`, padding + 6, height - padding - 4);
  ctx.textAlign = 'right';
  ctx.fillText(`${maxRP} RP`, width - padding - 6, padding + 12);
}
function buildMatchSummaryBody(data) {
  const teams = data?.teams || {};
  const defaultOrder = ['red', 'blue'];
  const renderedTeams = new Set();
  const teamCards = [];

  const describeTeam = (teamId) => {
    const meta = teamMeta?.[teamId] || { name: teamId ? teamId.toUpperCase() : 'Takım', color: teamId === 'red' ? '#ff5f5f' : '#5fb6ff' };
    const stats = teams[teamId] || { score: 0, kills: 0, assists: 0, deaths: 0 };
    const color = stats.color || meta.color || '#cdd6f4';
    return `
      <div class="summary-team-card">
        <div class="summary-team-header">
          <span class="summary-team-dot" style="background:${color}"></span>
          <span>${escapeHtml(meta.name)}</span>
        </div>
        <div class="summary-team-score">${Math.round(stats.score ?? 0)} Puan</div>
        <div class="summary-team-metrics">
          <span>Kill <strong>${Math.round(stats.kills ?? 0)}</strong></span>
          <span>Assist <strong>${Math.round(stats.assists ?? 0)}</strong></span>
          <span>Death <strong>${Math.round(stats.deaths ?? 0)}</strong></span>
        </div>
      </div>
    `;
  };

  for (const teamId of defaultOrder) {
    teamCards.push(describeTeam(teamId));
    renderedTeams.add(teamId);
  }
  for (const teamId of Object.keys(teams)) {
    if (renderedTeams.has(teamId)) continue;
    teamCards.push(describeTeam(teamId));
  }

  const playerSummaries = Array.isArray(data.players) ? data.players : [];
  const meSummary = playerSummaries.find(p => p.id === myId) || null;
  let playerCardHtml;
  if (meSummary) {
    const kills = Math.round(meSummary.kills ?? 0);
    const deaths = Math.round(meSummary.deaths ?? 0);
    const assists = Math.round(meSummary.assists ?? 0);
    const credits = Math.round(meSummary.credits ?? 0);
    const score = Math.round(meSummary.score ?? 0);
    const kda = ((kills + assists) / Math.max(1, deaths)).toFixed(2);
    const rankLabelRaw = typeof meSummary.rank === 'string'
      ? meSummary.rank
      : (meSummary.rank?.label || meSummary.rankLabel || (meSummary.isRanked ? 'Ranked' : 'Normal'));
    const rankPoints = typeof meSummary.rank === 'object' && typeof meSummary.rank.points === 'number'
      ? meSummary.rank.points
      : (typeof meSummary.rankPoints === 'number' ? meSummary.rankPoints : 0);
    const rankDelta = typeof meSummary.rankDelta === 'number' ? meSummary.rankDelta : 0;
    const rankIcon = getRankIcon(rankLabelRaw);
    const deltaText = `${rankDelta > 0 ? '+' : rankDelta < 0 ? '' : '±'}${rankDelta !== 0 ? rankDelta : 0} RP`;
    const rpText = `${rankPoints} RP (${deltaText})`;
    const result = data.winner === 'draw'
      ? 'Berabere'
      : meSummary.team && data.winner === meSummary.team
        ? 'Galibiyet'
        : 'Mağlubiyet';
    const resultClass = result === 'Galibiyet' ? 'win' : result === 'Mağlubiyet' ? 'loss' : 'draw';
    playerCardHtml = `
      <div class="summary-player-card">
        <div class="player-title">Senin Performansın</div>
        <div class="player-result ${resultClass}">${result}</div>
        <div class="player-grid">
          <div><span>Kill</span><strong>${kills}</strong></div>
          <div><span>Death</span><strong>${deaths}</strong></div>
          <div><span>Assist</span><strong>${assists}</strong></div>
          <div><span>KDA</span><strong>${kda}</strong></div>
          <div><span>Skor</span><strong>${score}</strong></div>
          <div><span>Credits</span><strong>${credits}</strong></div>
        </div>
        <div class="player-rank">${rankIcon} ${escapeHtml(rankLabelRaw)}<span>${rpText}</span></div>
      </div>
    `;
  } else {
    playerCardHtml = '<div class="summary-player-card summary-player-card-empty">Performans verisi bulunamadı.</div>';
  }

  const topPlayers = playerSummaries.length
    ? [...playerSummaries].sort((a, b) => {
        const scoreA = Math.round(b.score ?? 0) - Math.round(a.score ?? 0);
        if (scoreA !== 0) return scoreA;
        const killDiff = Math.round(b.kills ?? 0) - Math.round(a.kills ?? 0);
        if (killDiff !== 0) return killDiff;
        return (Math.round(b.assists ?? 0) - Math.round(a.assists ?? 0));
      }).slice(0, 6)
    : [];

  let leaderboardHtml = '';
  if (topPlayers.length) {
    const rows = topPlayers.map((p, index) => {
      const rankLabel = typeof p.rank === 'string'
        ? p.rank
        : (p.rank?.label || p.rankLabel || (p.isBot ? 'BOT' : 'Normal'));
      const icon = getRankIcon(rankLabel);
      const kills = Math.round(p.kills ?? 0);
      const deaths = Math.round(p.deaths ?? 0);
      const assists = Math.round(p.assists ?? 0);
      const score = Math.round(p.score ?? 0);
      const isMe = p.id === myId;
      const botBadge = p.isBot ? '<span class="bot-tag">BOT</span>' : '';
      return `
        <div class="summary-row${isMe ? ' my-row' : ''}">
          <span class="summary-cell place">#${index + 1}</span>
          <span class="summary-cell name">${icon} ${escapeHtml(p.name || 'Bilinmeyen')}${botBadge}</span>
          <span class="summary-cell kda">${kills}/${deaths}/${assists}</span>
          <span class="summary-cell score">${score}</span>
        </div>
      `;
    }).join('');
    leaderboardHtml = `
      <div class="summary-leaderboard">
        <div class="summary-leaderboard-title">En İyi Pilotlar</div>
        <div class="summary-leaderboard-rows">
          <div class="summary-row header">
            <span class="summary-cell place">Sıra</span>
            <span class="summary-cell name">Pilot</span>
            <span class="summary-cell kda">K / D / A</span>
            <span class="summary-cell score">Skor</span>
          </div>
          ${rows}
        </div>
      </div>
    `;
  }

  return `
    <div class="summary-upper">
      <div class="summary-teams">${teamCards.join('')}</div>
      <div class="summary-player-wrapper">${playerCardHtml}</div>
    </div>
    ${leaderboardHtml}
  `;
}

function showMatchSummary(data) {
  hideRankedLeaveOverlay(true);
  if (!matchSummaryOverlay || !matchSummaryResultEl || !matchSummaryBodyEl) return;
  latestMatchSummary = data;
  summaryRestartPending = false;
  if (matchSummaryPlayAgainBtn) {
    matchSummaryPlayAgainBtn.disabled = false;
    matchSummaryPlayAgainBtn.textContent = 'Yeni Maça Başla';
  }
  const teams = data?.teams || {};
  const redScore = Math.round(teams.red?.score ?? 0);
  const blueScore = Math.round(teams.blue?.score ?? 0);
  let resultText = 'Maç Berabere Bitti';
  if (data.winner && data.winner !== 'draw') {
    const meta = teamMeta?.[data.winner];
    resultText = `${meta?.name || (data.winner === 'red' ? 'Kırmızı Takım' : 'Mavi Takım')} kazandı`;
  }
  resultText += ` · ${redScore} - ${blueScore}`;
  matchSummaryResultEl.textContent = resultText;
  matchSummaryBodyEl.innerHTML = buildMatchSummaryBody(data);
  matchSummaryOverlay.classList.add('visible');
  hideScoreboard();
}

function hideMatchSummary() {
  if (!matchSummaryOverlay) return;
  matchSummaryOverlay.classList.remove('visible');
  latestMatchSummary = null;
  summaryRestartPending = false;
  if (matchSummaryPlayAgainBtn) {
    matchSummaryPlayAgainBtn.disabled = false;
    matchSummaryPlayAgainBtn.textContent = 'Yeni Maça Başla';
  }
}

function requestMatchRestart() {
  if (summaryRestartPending) return;
  if (!socket.connected) {
    showToast('Sunucu', 'Sunucuya bağlı değilsin.', 'warning');
    return;
  }
  summaryRestartPending = true;
  if (matchSummaryPlayAgainBtn) {
    matchSummaryPlayAgainBtn.disabled = true;
    matchSummaryPlayAgainBtn.textContent = 'Hazırlanıyor...';
  }
  socket.emit('requestMatchStart', { mode: myMode });
}

function returnToMainMenu() {
  hideRankedLeaveOverlay(true);
  hideMatchSummary();
  hideScoreboard();
  hideLoadingScreen(true);
  streakNotifications = [];
  killFeed = [];
  particles = [];
  damageIndicators = [];
  bullets = [];
  projectiles = [];
  players.clear();
  matchInfo = null;
  keys.clear();
  mouseDown = false;
  mouseRightDown = false;
  spaceDown = false;
  thrust = false;
  turn = 0;
  summaryRestartPending = false;
  if (socket.connected) {
    socket.disconnect();
  }
  gameStarted = false;
  showMainMenu().then(() => {
    updateAccountStatus('Ana menüye döndün.', 'info');
  }).catch(() => {});
}

function populateMenuStats(user = {}) {
  // stats no longer displayed on main menu; delegate to career panel
}

function showLoginCard() {
  if (loginCard) loginCard.classList.remove('hidden');
  if (profileCard) profileCard.classList.add('hidden');
  if (profileRankedNoteEl) {
    profileRankedNoteEl.textContent = '';
    profileRankedNoteEl.classList.remove('fulfilled');
  }
  const careerBtn = document.getElementById('career-button');
  if (careerBtn) careerBtn.classList.add('hidden');
}

function showProfileCard() {
  if (loginCard) loginCard.classList.add('hidden');
  if (profileCard) {
    profileCard.classList.remove('hidden');
    if (profileUsernameEl && currentUser) {
      profileUsernameEl.textContent = currentUser.username || '';
    }
  }
  const careerBtn = document.getElementById('career-button');
  if (careerBtn) careerBtn.classList.remove('hidden');
}

function getNormalMatchesPlayed() {
  return currentUser && typeof currentUser.normalMatches === 'number'
    ? currentUser.normalMatches
    : 0;
}

function canPlayRanked() {
  return getNormalMatchesPlayed() >= RANKED_UNLOCK_MATCHES;
}

function updateRankedRequirementDisplay() {
  const played = getNormalMatchesPlayed();
  const unlocked = played >= RANKED_UNLOCK_MATCHES;
  if (rankedRequirementEl) {
    if (unlocked) {
      rankedRequirementEl.textContent = 'Ranked maçlara hazırsın. İyi şanslar!';
      rankedRequirementEl.classList.add('fulfilled');
    } else {
      rankedRequirementEl.textContent = `Ranked açmak için ${played}/${RANKED_UNLOCK_MATCHES} normal maç tamamlamalısın.`;
      rankedRequirementEl.classList.remove('fulfilled');
    }
  }
  if (playButtonsContainer) {
    playButtonsContainer.classList.toggle('ranked-locked', !unlocked);
  }
  if (profileRankedNoteEl) {
    if (!currentUser) {
      profileRankedNoteEl.textContent = 'Normal maçlarını tamamlayarak ranked modunu açabilirsin.';
      profileRankedNoteEl.classList.remove('fulfilled');
    } else if (unlocked) {
      profileRankedNoteEl.textContent = 'Ranked maçlara katılabilirsin. Bol şans!';
      profileRankedNoteEl.classList.add('fulfilled');
    } else {
      profileRankedNoteEl.textContent = `Ranked için ${played}/${RANKED_UNLOCK_MATCHES} normal maç gerekli.`;
      profileRankedNoteEl.classList.remove('fulfilled');
    }
  }
  updateQueueUI();
}

function setPlayButtonsEnabled(enabled) {
  playButtonsAreEnabled = !!enabled;
  if (playButtonsContainer) {
    playButtonsContainer.classList.toggle('locked', !enabled);
  }
  updateRankedRequirementDisplay();
}

function clearRegisterForm() {
  if (registerUsernameInput) registerUsernameInput.value = '';
  if (registerPasswordInput) registerPasswordInput.value = '';
  if (registerConfirmInput) registerConfirmInput.value = '';
  updateAccountStatus('', 'info', 'register-status');
}

function showRegisterCard() {
  if (!registerCard) return;
  registerCard.classList.remove('hidden');
  updateAccountStatus('', 'info', 'register-status');
  if (registerUsernameInput) {
    registerUsernameInput.focus();
  }
}

function hideRegisterCard(clear = true) {
  if (!registerCard) return;
  registerCard.classList.add('hidden');
  if (clear) {
    clearRegisterForm();
  }
}

function handleAuthSuccess(user, message = '✅ Giriş başarılı!') {
  currentUser = user;
  currentUser.normalMatches = user.normalMatches || 0;
  currentUser.totalDeaths = user.totalDeaths || 0;
  currentUser.rankPoints = user.rankPoints || 0;
  currentUser.rankLabel = user.rankLabel || user.highestRankLabel || 'Demir 1';
  currentUser.highestRankPoints = user.highestRankPoints || 0;
  currentUser.highestRankLabel = user.highestRankLabel || currentUser.rankLabel || 'Demir 1';
  currentUser.level = user.level || 1;
  currentUser.xp = user.xp || 0;
  currentUser.credits = user.credits || 0;
  currentUser.skills = { ...DEFAULT_SKILLS, ...(user.skills || {}) };
  currentUser.weapons = { ...DEFAULT_WEAPONS, ...(user.weapons || {}) };
  isAuthenticated = true;
  showProfileCard();
  populateMenuStats(user || {});
  setPlayButtonsEnabled(true);
  updateAccountStatus(message, 'success');
  updateAccountStatus('', 'info', 'register-status');
  hideRegisterCard();
  if (loginUsernameInput && user && user.username) {
    loginUsernameInput.value = user.username;
  }
  if (loginPasswordInput) {
    loginPasswordInput.value = '';
  }
  connectSocket();
  updateRankedRequirementDisplay();
}

async function handleLogin() {
  if (!loginUsernameInput || !loginPasswordInput) return;
  const username = loginUsernameInput.value.trim();
  const password = loginPasswordInput.value.trim();
  if (!username || username.length < 3) {
    updateAccountStatus('❌ Kullanıcı adı en az 3 karakter olmalı!', 'error');
    return;
  }
  if (!password || password.length < 3) {
    updateAccountStatus('❌ Şifre en az 3 karakter olmalı!', 'error');
    return;
  }
  updateAccountStatus('⏳ Giriş yapılıyor...', 'info');
  if (loginSubmitBtn) loginSubmitBtn.disabled = true;
  try {
    const user = await loginUser(username, password);
    handleAuthSuccess(user, `✅ Hoş geldin, ${user.username || username}!`);
  } catch (error) {
    updateAccountStatus('❌ ' + (error.message || 'Giriş başarısız'), 'error');
  } finally {
    if (loginSubmitBtn) loginSubmitBtn.disabled = false;
  }
}

async function handleRegister() {
  if (!registerUsernameInput || !registerPasswordInput || !registerConfirmInput) return;
  const username = registerUsernameInput.value.trim();
  const password = registerPasswordInput.value.trim();
  const confirm = registerConfirmInput.value.trim();
  if (!username || username.length < 3) {
    updateAccountStatus('❌ Kullanıcı adı en az 3 karakter olmalı!', 'error', 'register-status');
    return;
  }
  if (!password || password.length < 3) {
    updateAccountStatus('❌ Şifre en az 3 karakter olmalı!', 'error', 'register-status');
    return;
  }
  if (password !== confirm) {
    updateAccountStatus('❌ Şifreler uyuşmuyor!', 'error', 'register-status');
    return;
  }
  updateAccountStatus('⏳ Kayıt oluşturuluyor...', 'info', 'register-status');
  if (registerSubmitBtn) registerSubmitBtn.disabled = true;
  try {
    const user = await registerUser(username, password);
    handleAuthSuccess(user, '✅ Kayıt tamamlandı! Giriş yapıldı.');
    clearRegisterForm();
  } catch (error) {
    updateAccountStatus('❌ ' + (error.message || 'Kayıt başarısız'), 'error', 'register-status');
  } finally {
    if (registerSubmitBtn) registerSubmitBtn.disabled = false;
  }
}

function handleLogout(event) {
  if (event) event.preventDefault();
  localStorage.removeItem('space-sonar-creds');
  currentUser = null;
  isAuthenticated = false;
  gameStarted = false;
  queueState = { mode: null, normalSize: 0, rankedSize: 0 };
  if (socket.connected) {
    socket.disconnect();
  }
  hideLoadingScreen(true);
  if (loginUsernameInput) loginUsernameInput.value = '';
  if (loginPasswordInput) loginPasswordInput.value = '';
  showLoginCard();
  setPlayButtonsEnabled(false);
  updateRankedRequirementDisplay();
  updateQueueUI();
  updateAccountStatus('ℹ️ Oturum kapatıldı.', 'info');
  renderCareerPanel();
  showMainMenu();
}

function joinQueue(mode) {
  if (!isAuthenticated || !currentUser) {
    updateAccountStatus('❌ Önce giriş yapmalısın.', 'error');
    return;
  }
  if (!socket.connected) {
    connectSocket();
  }
  selectedMode = mode === 'ranked' ? 'ranked' : 'normal';
  socket.emit('queue:join', { mode: selectedMode });
}

function leaveQueue() {
  if (!socket.connected) return;
  socket.emit('queue:leave');
}

function updateQueueUI() {
  const normalCount = queueState.normalSize || 0;
  const rankedCount = queueState.rankedSize || 0;
  const currentQueue = queueState.mode;
  const inNormal = currentQueue === 'normal';
  const inRanked = currentQueue === 'ranked';
  const unlockedRanked = canPlayRanked();
  if (queueNormalStatusEl) {
    queueNormalStatusEl.textContent = `Sırada ${normalCount} oyuncu`;
  }
  if (queueRankedStatusEl) {
    queueRankedStatusEl.textContent = `Sırada ${rankedCount} oyuncu`;
  }
  if (queueNormalJoinBtn) {
    const disabled = !isAuthenticated || inRanked || !playButtonsAreEnabled;
    queueNormalJoinBtn.disabled = disabled;
    queueNormalJoinBtn.classList.toggle('hidden', inNormal);
  }
  if (queueNormalLeaveBtn) {
    queueNormalLeaveBtn.classList.toggle('hidden', !inNormal);
  }
  if (queueRankedJoinBtn) {
    const disabled = !isAuthenticated || inNormal || !playButtonsAreEnabled || !unlockedRanked;
    queueRankedJoinBtn.disabled = disabled;
    queueRankedJoinBtn.classList.toggle('hidden', inRanked);
  }
  if (queueRankedLeaveBtn) {
    queueRankedLeaveBtn.classList.toggle('hidden', !inRanked);
  }
  if (queueInfoEl) {
    if (!isAuthenticated) {
      queueInfoEl.textContent = 'Giriş yaptıktan sonra sıraya girebilirsin.';
    } else if (inRanked) {
      queueInfoEl.textContent = 'Ranked sırasında bekleniyor...';
    } else if (inNormal) {
      queueInfoEl.textContent = 'Normal sırasında bekleniyor...';
    } else if (!unlockedRanked) {
      queueInfoEl.textContent = `Ranked için ${getNormalMatchesPlayed()}/${RANKED_UNLOCK_MATCHES} normal maç gerekli.`;
    } else if (!playButtonsAreEnabled) {
      queueInfoEl.textContent = 'Sunucuya bağlanılıyor...';
    } else {
      queueInfoEl.textContent = 'Bir mod seçip sıraya gir.';
    }
  }
}

socket.on('saveProgress', (data) => {
  saveProgress(data);
});

socket.on('queue:status', data => {
  if (!data) return;
  queueState.mode = data.mode || null;
  queueState.normalSize = data.normalSize ?? queueState.normalSize;
  queueState.rankedSize = data.rankedSize ?? queueState.rankedSize;
  updateQueueUI();
});

socket.on('queue:summary', data => {
  if (!data) return;
  queueState.normalSize = data.normalSize ?? queueState.normalSize;
  queueState.rankedSize = data.rankedSize ?? queueState.rankedSize;
  updateQueueUI();
});

socket.on('queue:joined', data => {
  if (data && data.mode) {
    queueState.mode = data.mode;
    updateQueueUI();
    updateAccountStatus(`✅ ${data.mode === 'ranked' ? 'Ranked' : 'Normal'} sırasına katıldın.`, 'success');
  }
});

socket.on('queue:left', () => {
  queueState.mode = null;
  updateQueueUI();
});

socket.on('queue:error', data => {
  const message = typeof data === 'string' ? data : data?.message;
  if (message) updateAccountStatus('❌ ' + message, 'error');
});


