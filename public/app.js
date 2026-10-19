/* DG//VOX app — 3 tabs: Agent (home) / Simple Voice / Text Intel */
// NOTE: imports the esbuild bundle (not deepgram-agent.js directly),
// so @deepgram/agents resolves locally. Rebuild with `npm run build`.
import { configure, buildSettings, buildAgentConfig, registerPlugin, startSession } from './deepgram-agent.bundle.js';

configure({ tokenUrl: '/api/deepgram/token' });

// demo client-side plugins (same registry the agent uses)
try {
  registerPlugin({
    name: 'get_weather',
    description: 'Return current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    handler: async ({ city }) => {
      const r = await fetch(`/api/agent/functions/get_weather`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city }),
      });
      return r.json();
    },
  });
} catch { /* already registered on hot reload */ }

const $ = (id) => document.getElementById(id);
const t0 = Date.now();
let turns = 0, phase = 'IDLE';

// ---------- session persistence (survive a page refresh) ----------
// sessionStorage (not localStorage): scoped to this tab, cleared when the
// tab actually closes, but — unlike page JS state — untouched by a reload.
const SESSION_KEY = 'dgvox.session.v1';
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function saveSession(patch) {
  try {
    const cur = loadSession() || { transcript: [], turns: 0, live: false };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch { /* storage unavailable (private mode, quota) — degrade to no persistence */ }
}
const savedSession = loadSession();

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    $('tab-' + b.dataset.tab).classList.add('active');
  };
});

// ---------- clock / health ----------
setInterval(() => {
  const s = Math.floor((Date.now() - t0) / 1000);
  $('uptime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}, 1000);

fetch('/api/health').then((r) => r.json()).then((h) => {
  $('health').textContent = h.hasPrimary ? 'KEY OK' : 'NO KEY';
}).catch(() => { $('health').textContent = 'OFFLINE'; });

// ---------- shared log / transcript ----------
function stamp() {
  const d = Math.floor((Date.now() - t0) / 1000);
  return `00:${String(Math.floor(d / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}`;
}
function logLine(label) {
  const div = document.createElement('div');
  div.style.cssText = 'display:grid;grid-template-columns:58px 1fr;gap:12px;padding:2px 0';
  div.innerHTML = `<span style="color:rgba(10,10,10,.66)">${stamp()}</span><span></span>`;
  div.lastChild.textContent = label;
  $('log').prepend(div);
  while ($('log').children.length > 40) $('log').lastChild.remove();
}
function addTranscript(role, text, opts = {}) {
  const div = document.createElement('div');
  div.className = 'tline';
  div.innerHTML = `<span style="font-size:10px;color:rgba(10,10,10,.66);padding-top:5px">${stamp()}</span>
    <div style="display:grid;gap:3px"><span style="font-size:10px;letter-spacing:.24em;color:rgba(10,10,10,.66)"></span>
    <span style="font-size:14px;line-height:1.55"></span></div>`;
  div.querySelectorAll('span')[1].textContent = role;
  div.querySelectorAll('span')[2].textContent = text;
  $('transcript').appendChild(div);
  if (!opts.replay) {
    const s = loadSession() || { transcript: [], turns: 0, live: false };
    s.transcript = [...s.transcript, { role, text, seed: !!opts.seed }].slice(-50);
    saveSession(s);
  }
}
function setPhase(p) {
  phase = p;
  $('phase').textContent = p;
  $('connPill').textContent = handle ? `LIVE · ${p}` : 'IDLE';
}
if (savedSession?.transcript?.length) {
  // Replay the prior conversation so a refresh doesn't wipe the transcript.
  savedSession.transcript.forEach((m) => addTranscript(m.role, m.text, { replay: true }));
  turns = savedSession.turns || 0;
  $('turns').textContent = String(turns).padStart(2, '0');
  logLine('transcript restored from previous session');
} else {
  addTranscript('AGENT', 'Channel open. What do you need?', { seed: true });
}
logLine('Welcome · session established (demo seed)');
logLine('SettingsApplied (demo seed)');

// ---------- agent config ----------
const cfg = {
  listenModel: 'flux-general-en', listenVersion: 'v2', listenLanguage: 'en',
  eotThreshold: 0.7, eagerEotThreshold: 0.5, eotTimeoutMs: 5000, keyterms: '',
  thinkProvider: 'google', thinkModel: 'gemini-3.1-flash-lite', temperature: 0.6,
  speakProvider: 'deepgram', speakModel: 'flux-heather-en', speakVersion: 'v2',
  speed: 1.0, expressivity: 0,
  inputEncoding: 'linear16', inputSampleRate: 24000,
  outputEncoding: 'linear16', outputSampleRate: 24000, outputContainer: 'none',
  greeting: 'Channel open. What do you need?',
  prompt: 'You are a terse, precise voice operator with real tools: list_files and read_file, both scoped to the user\'s home directory (path is relative to home, e.g. "Projects" or "Documents/notes", blank = home root). When asked about files or folders, call the exact relative path implied by the request — do not default to the home root unless asked for that. Report only what the tool actually returned; never guess or invent file names. Answer in one or two short sentences.',
};
const OPTS = {
  listenModel: ['flux-general-en', 'flux-general-multi', 'nova-3', 'nova-2'],
  listenVersion: ['v2', 'v1'], language: ['en', 'en-US', 'en-GB', 'es', 'fr', 'de', 'hi', 'ja', 'multi'],
  thinkProvider: ['google', 'open_ai', 'anthropic', 'groq', 'aws_bedrock', 'custom'],
  thinkModel: {
    google: ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    open_ai: ['gpt-5-mini', 'gpt-5', 'gpt-4.1-mini'],
    anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
    groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    aws_bedrock: ['anthropic.claude-3-5-haiku', 'amazon.nova-lite-v1'], custom: ['byo-model'],
  },
  speakProvider: ['deepgram', 'eleven_labs', 'cartesia', 'open_ai', 'aws_polly'],
  // Full Deepgram TTS catalog: 102 Aura voices from GET /v1/models
  // (verified live 2026-09-13) + all 36 Flux voices from
  // developers.deepgram.com/docs/flux-tts/voices (that endpoint doesn't
  // list Flux at all — an earlier pass missed this and wrongly claimed no
  // "priya" voice existed; flux-priya-en is real). Every Flux voice below
  // individually verified live against the Agent API 2026-09-13.
  speakModel: {
    deepgram: [
      'flux-hannah-en', 'flux-kit-en', 'flux-alexis-en', 'flux-cliff-en', 'flux-sienna-en',
      'flux-cole-en', 'flux-brooke-en', 'flux-colin-en', 'flux-gemma-en', 'flux-haley-en',
      'flux-heather-en', 'flux-miles-en', 'flux-sean-en', 'flux-bree-en', 'flux-brittany-en',
      'flux-bruce-en', 'flux-conor-en', 'flux-donovan-en', 'flux-drew-en', 'flux-elise-en',
      'flux-jack-en', 'flux-kai-en', 'flux-kelsey-en', 'flux-maeve-en', 'flux-marcelo-en',
      'flux-marcus-en', 'flux-meena-en', 'flux-meghan-en', 'flux-naveen-en', 'flux-paige-en',
      'flux-priya-en', 'flux-rufus-en', 'flux-sharon-en', 'flux-tanner-en', 'flux-wade-en',
      'flux-wes-en',
      'aura-2-agathe-fr', 'aura-2-agustina-es', 'aura-2-alvaro-es', 'aura-2-ama-ja',
      'aura-2-amalthea-en', 'aura-2-andromeda-en', 'aura-2-antonia-es', 'aura-2-apollo-en',
      'aura-2-aquila-es', 'aura-2-arcas-en', 'aura-2-aries-en', 'aura-2-asteria-en',
      'aura-2-athena-en', 'aura-2-atlas-en', 'aura-2-aurelia-de', 'aura-2-aurora-en',
      'aura-2-beatrix-nl', 'aura-2-callista-en', 'aura-2-carina-es', 'aura-2-celeste-es',
      'aura-2-cesare-it', 'aura-2-cinzia-it', 'aura-2-cora-en', 'aura-2-cordelia-en',
      'aura-2-cornelia-nl', 'aura-2-daphne-nl', 'aura-2-delia-en', 'aura-2-demetra-it',
      'aura-2-diana-es', 'aura-2-dionisio-it', 'aura-2-draco-en', 'aura-2-ebisu-ja',
      'aura-2-elara-de', 'aura-2-electra-en', 'aura-2-elio-it', 'aura-2-estrella-es',
      'aura-2-fabian-de', 'aura-2-flavio-it', 'aura-2-fujin-ja', 'aura-2-gloria-es',
      'aura-2-harmonia-en', 'aura-2-hector-fr', 'aura-2-helena-en', 'aura-2-hera-en',
      'aura-2-hermes-en', 'aura-2-hestia-nl', 'aura-2-hyperion-en', 'aura-2-iris-en',
      'aura-2-izanami-ja', 'aura-2-janus-en', 'aura-2-javier-es', 'aura-2-julius-de',
      'aura-2-juno-en', 'aura-2-jupiter-en', 'aura-2-kara-de', 'aura-2-lara-de',
      'aura-2-lars-nl', 'aura-2-leda-nl', 'aura-2-livia-it', 'aura-2-luciano-es',
      'aura-2-luna-en', 'aura-2-maia-it', 'aura-2-mars-en', 'aura-2-melia-it',
      'aura-2-minerva-en', 'aura-2-neptune-en', 'aura-2-nestor-es', 'aura-2-odysseus-en',
      'aura-2-olivia-es', 'aura-2-ophelia-en', 'aura-2-orion-en', 'aura-2-orpheus-en',
      'aura-2-pandora-en', 'aura-2-phoebe-en', 'aura-2-pluto-en', 'aura-2-rhea-nl',
      'aura-2-roman-nl', 'aura-2-sander-nl', 'aura-2-saturn-en', 'aura-2-selena-es',
      'aura-2-selene-en', 'aura-2-silvia-es', 'aura-2-sirio-es', 'aura-2-thalia-en',
      'aura-2-theia-en', 'aura-2-uzume-ja', 'aura-2-valerio-es', 'aura-2-vesta-en',
      'aura-2-viktoria-de', 'aura-2-zeus-en',
      'aura-angus-en', 'aura-arcas-en', 'aura-asteria-en', 'aura-athena-en', 'aura-helios-en',
      'aura-hera-en', 'aura-luna-en', 'aura-orion-en', 'aura-orpheus-en', 'aura-perseus-en',
      'aura-stella-en', 'aura-zeus-en',
    ],
    eleven_labs: ['eleven_flash_v2_5', 'eleven_turbo_v2_5'], cartesia: ['sonic-3', 'sonic-2'],
    open_ai: ['gpt-4o-mini-tts', 'tts-1'], aws_polly: ['neural', 'generative'],
  },
  speakVersion: ['v2', 'v1'], encoding: ['linear16', 'mulaw', 'alaw', 'opus', 'mp3'],
  sampleRate: [8000, 16000, 24000, 44100, 48000], container: ['none', 'wav', 'ogg'],
};
// Push a config field change to a *live* connected agent instead of only
// taking effect on the next reconnect. Deepgram's UpdateSpeak/UpdateListen
// client messages apply mid-session — previously nothing called them, so
// changing e.g. the Voice dropdown silently did nothing until disconnect+
// reconnect, which looked like "changing voice doesn't work".
function pushLiveUpdate(path) {
  if (!handle) return;
  try {
    const built = buildAgentConfig(fullCfg());
    if (path.startsWith('agent.speak')) { handle.updateSpeak(built.speak); logLine('UpdateSpeak → live'); }
    else if (path.startsWith('agent.listen')) { handle.updateListen(built.listen.provider); logLine('UpdateListen → live'); }
  } catch (e) { logLine('live update failed: ' + (e?.message || e)); }
}
let showAdv = false;
function renderFields() {
  const box = $('fields'); box.innerHTML = '';
  const sel = (label, path, key, options) => ({ label, path, kind: 'sel', key, options });
  const num = (label, path, key, min, max, step) => ({ label, path, kind: 'num', key, min, max, step });
  const txt = (label, path, key) => ({ label, path, kind: 'txt', key });
  let list = [
    sel('Listen model', 'agent.listen.provider.model', 'listenModel', OPTS.listenModel),
    sel('LLM provider', 'agent.think.provider.type', 'thinkProvider', OPTS.thinkProvider),
    sel('LLM model', 'agent.think.provider.model', 'thinkModel', OPTS.thinkModel[cfg.thinkProvider] || []),
    sel('Voice', 'agent.speak.provider.model', 'speakModel', OPTS.speakModel[cfg.speakProvider] || []),
    num('Speed', 'agent.speak.provider.speed', 'speed', 0.5, 1.5, 0.05),
    num('EOT threshold', 'agent.listen.provider.eot_threshold', 'eotThreshold', 0.5, 1, 0.01),
  ];
  if (showAdv) list = [...list,
    sel('Listen version', 'agent.listen.provider.version', 'listenVersion', OPTS.listenVersion),
    sel('Language', 'agent.listen.provider.language', 'listenLanguage', OPTS.language),
    txt('Keyterms', 'agent.listen.provider.keyterms', 'keyterms'),
    num('Eager EOT', 'agent.listen.provider.eager_eot_threshold', 'eagerEotThreshold', 0.3, 0.9, 0.01),
    num('EOT timeout', 'agent.listen.provider.eot_timeout_ms', 'eotTimeoutMs', 500, 20000, 100),
    num('Temperature', 'agent.think.provider.temperature', 'temperature', 0, 2, 0.05),
    sel('TTS provider', 'agent.speak.provider.type', 'speakProvider', OPTS.speakProvider),
    sel('TTS version', 'agent.speak.provider.version', 'speakVersion', OPTS.speakVersion),
    num('Expressivity', 'agent.speak.provider.expressivity', 'expressivity', -2, 2, 1),
    sel('Input encoding', 'audio.input.encoding', 'inputEncoding', OPTS.encoding),
    sel('Input rate', 'audio.input.sample_rate', 'inputSampleRate', OPTS.sampleRate),
    sel('Output encoding', 'audio.output.encoding', 'outputEncoding', OPTS.encoding),
    sel('Output rate', 'audio.output.sample_rate', 'outputSampleRate', OPTS.sampleRate),
    sel('Container', 'audio.output.container', 'outputContainer', OPTS.container),
  ];
  for (const f of list) {
    const row = document.createElement('div'); row.className = 'field';
    row.innerHTML = `<div><label></label><div class="path"></div></div>`;
    row.querySelector('label').textContent = f.label;
    row.querySelector('.path').textContent = f.path;
    let el;
    if (f.kind === 'sel') {
      el = document.createElement('select');
      f.options.map(String).forEach((o) => {
        const op = document.createElement('option'); op.value = o; op.textContent = o; el.appendChild(op);
      });
      el.value = String(cfg[f.key]);
      el.onchange = () => {
        let v = el.value;
        if (typeof cfg[f.key] === 'number') v = Number(v);
        cfg[f.key] = v;
        if (f.key === 'thinkProvider') cfg.thinkModel = OPTS.thinkModel[v][0];
        if (f.key === 'speakProvider') cfg.speakModel = OPTS.speakModel[v][0];
        renderFields(); renderSettings(); pushLiveUpdate(f.path);
      };
    } else if (f.kind === 'num') {
      el = document.createElement('input');
      el.type = 'number'; el.min = f.min; el.max = f.max; el.step = f.step; el.value = cfg[f.key];
      el.onchange = () => { cfg[f.key] = Number(el.value); renderSettings(); pushLiveUpdate(f.path); };
    } else {
      el = document.createElement('input'); el.type = 'text'; el.value = cfg[f.key] || '';
      el.onchange = () => { cfg[f.key] = el.value; renderSettings(); pushLiveUpdate(f.path); };
    }
    row.appendChild(el); box.appendChild(row);
  }
}
function renderSettings() {
  $('settingsJson').textContent = JSON.stringify(buildSettings({ ...cfg, prompt: $('prompt').value }), null, 2);
  $('srLabel').textContent = `${cfg.inputSampleRate / 1000}k · ${cfg.inputEncoding}`;
}
$('prompt').oninput = renderSettings;
$('btnAdv').onclick = () => {
  showAdv = !showAdv;
  $('btnAdv').textContent = showAdv ? '— FEWER OPTIONS' : '+ ALL OPTIONS';
  $('advBox').style.display = showAdv ? 'block' : 'none';
  renderFields();
};
$('btnCopy').onclick = async () => {
  const j = JSON.stringify(buildSettings({ ...cfg, prompt: $('prompt').value }), null, 2);
  try { await navigator.clipboard.writeText(j); } catch { /* clipboard blocked */ }
  $('btnCopy').textContent = 'COPIED';
  setTimeout(() => ($('btnCopy').textContent = 'COPY SETTINGS'), 1400);
};
renderFields(); renderSettings();

// plugins panel
[['agentSocket', 'wss://agent.deepgram.com/v1/agent/converse', 'LIVE'],
 ['tokenProxy', '/api/deepgram/token → /v1/auth/grant', 'READY'],
 ['functionEndpoint', '/api/agent/functions', 'READY'],
 ['end_call', 'function · defer_until_eot', 'CLIENT'],
 ['get_weather', 'function · client→server demo', 'CLIENT'],
 ['lookup_record', 'function · client→server demo', 'CLIENT'],
 ['list_files', 'function · real fs, sandboxed to ~ ', 'CLIENT'],
 ['read_file', 'function · real fs, sandboxed to ~ ', 'CLIENT'],
].forEach(([n, d, s]) => {
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;justify-content:space-between;gap:12px;align-items:baseline;border-bottom:1px dotted rgba(10,10,10,.3);padding-bottom:5px';
  div.innerHTML = `<div style="display:grid;gap:1px;min-width:0"><span></span><span style="font-size:10px;color:rgba(10,10,10,.66);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span></div><span style="font-size:10px;color:rgba(10,10,10,.66)"></span>`;
  div.children[0].children[0].textContent = n;
  div.children[0].children[1].textContent = d;
  div.children[1].textContent = s;
  $('plugins').appendChild(div);
});

// ---------- mic arm + terrain viz ----------
let stream = null, ac = null, analyser = null, bins = null, vizT = 0, handle = null;
let unlockCtx = null, audioTick = null;

/** Show live audio-output health in the pill; nudge resume on tap. */
function playerState() {
  try {
    const p = handle?.player;
    if (!p) return 'no-player';
    if (typeof p._ensureContext === 'function') { try { p._ensureContext(); } catch { /* noop */ } }
    return (p.ctx && p.ctx.state) || 'unknown';
  } catch { return 'unknown'; }
}
function probeAudio() {
  if (audioTick) clearInterval(audioTick);
  const paint = () => {
    if (!handle) return;
    const st = playerState();
    const muted = handle.player?.muted ? 'muted' : 'audible';
    $('connPill').textContent = `LIVE · ${phase} · out:${st} ${muted}`;
    if (st === 'suspended') logLineOnce('playerCtx', '🔇 output AudioContext SUSPENDED — tap the page/canvas to unlock audio');
  };
  paint();
  audioTick = setInterval(paint, 2000);
}
const _seen = new Set();
function logLineOnce(key, label) {
  if (_seen.has(key)) return;
  _seen.add(key);
  logLine(label);
}
document.addEventListener('pointerdown', () => {
  // Any tap retries audio unlock (autoplay policy).
  try { unlockCtx?.resume?.().catch(() => {}); } catch { /* noop */ }
  try { handle?.player?._ensureContext?.(); handle?.player?.ctx?.resume?.().catch(() => {}); } catch { /* noop */ }
});
$('btnMic').onclick = async () => {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop()); stream = null; analyser = null;
    $('btnMic').textContent = 'ARM MIC'; logLine('mic released'); return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    analyser = ac.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.72;
    src.connect(analyser); bins = new Uint8Array(analyser.frequencyBinCount);
    $('btnMic').textContent = 'MIC LIVE'; logLine(`mic armed · linear16 @ ${cfg.inputSampleRate}`);
  } catch { logLine('mic denied · falling back to synthetic field'); }
};

// terrain canvas (synthetic fallback + real spectra when agent connected)
(() => {
  const COLS = 96, ROWS = 46;
  const rows = Array.from({ length: ROWS }, () => new Float32Array(COLS));
  const cvs = $('vox'), ctx = cvs.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  let W = 0, H = 0;
  const fit = () => {
    const r = cvs.getBoundingClientRect();
    if (r.width < 1) return false;
    if (Math.abs(r.width - W) > 0.5 || Math.abs(r.height - H) > 0.5) {
      W = r.width; H = r.height;
      cvs.width = Math.round(W * dpr); cvs.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return true;
  };
  const sample = () => {
    const out = new Float32Array(COLS);
    // real mic spectra when armed+listening
    if (analyser && (phase === 'LISTENING' || phase === 'IDLE') && !handle) {
      analyser.getByteFrequencyData(bins);
      const step = Math.floor(bins.length * 0.55 / COLS) || 1;
      for (let i = 0; i < COLS; i++) {
        let m = 0;
        for (let k = 0; k < step; k++) m = Math.max(m, bins[i * step + k] || 0);
        out[i] = (m / 255) ** 1.3;
      }
      return out;
    }
    // real agent spectra when connected
    if (handle?.inputSpectrum && phase !== 'SPEAKING') {
      try {
        const b = handle.inputSpectrum();
        if (b?.length) {
          const step = Math.max(1, Math.floor(b.length * 0.6 / COLS));
          for (let i = 0; i < COLS; i++) out[i] = ((b[i * step] || 0) / 255) ** 1.2;
          return out;
        }
      } catch { /* fall through */ }
    }
    const t = vizT, gain = phase === 'LISTENING' ? 1 : phase === 'SPEAKING' ? 0.8 : phase === 'THINKING' ? 0.6 : 0.48;
    for (let i = 0; i < COLS; i++) {
      const x = i / COLS;
      const ridge = Math.exp(-((x - 0.44) ** 2) / 0.018) * (1.05 + 0.2 * Math.sin(t * 1.3));
      const ridge2 = Math.exp(-((x - 0.62) ** 2) / 0.004) * 0.65 * (0.7 + 0.3 * Math.sin(t * 2.1 + 1));
      const ridge3 = Math.exp(-((x - 0.22) ** 2) / 0.01) * 0.42 * (0.7 + 0.3 * Math.sin(t * 1.6 + 2.4));
      const foot = Math.exp(-((x - 0.5) ** 2) / 0.16) * 0.3;
      const ripple = 0.13 * Math.sin(x * 24 + t * 2.6) * Math.sin(x * 9 - t * 1.1);
      out[i] = Math.max(0, (ridge + ridge2 + ridge3 + foot + ripple + 0.06) * gain);
    }
    return out;
  };
  for (let r = ROWS - 1; r >= 0; r--) { vizT = -r * 0.11; rows[r] = sample(); }
  vizT = 0;
  let lastRow = 0, lastDb = 0, lastStep = 0;
  const frame = (now) => {
    vizT = now / 1000;
    if (!lastRow) lastRow = now - 70;
    let n = 0;
    while (now - lastRow >= 60 && n < 4) { rows.pop(); rows.unshift(sample()); lastRow += 60; n++; }
    const peak = Math.max(...rows[0]);
    if (now - lastDb >= 350) {
      lastDb = now;
      const db = Math.round(-60 + Math.min(1, peak) * 52);
      const speaking = phase === 'SPEAKING';
      $('inDb').textContent = speaking ? -58 : db;
      $('outDb').textContent = speaking ? db : -58;
    }
    ctx.clearRect(0, 0, W, H);
    const baseY = H * 0.76, rowGap = (H * 0.58) / ROWS, amp = H * 0.4;
    ctx.fillStyle = '#0A0A0A';
    for (let r = ROWS - 1; r >= 0; r--) {
      const depth = r / (ROWS - 1), squeeze = 0.5 + 0.5 * (1 - depth * 0.42);
      const y0 = baseY - r * rowGap, alpha = Math.max(0.14, 0.62 - depth * 0.46);
      const dot = Math.max(0.7, 1.7 - depth * 0.9), pts = [];
      for (let i = 0; i < COLS; i++) {
        const v = rows[r][i];
        pts.push([W / 2 + (i / (COLS - 1) - 0.5) * W * squeeze, y0 - v * amp * (1 - depth * 0.5), v]);
      }
      ctx.globalAlpha = r === 0 ? 0.92 : alpha * 0.7;
      ctx.strokeStyle = '#0A0A0A'; ctx.lineWidth = r === 0 ? 1.15 : 0.55;
      ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
      ctx.globalAlpha = r === 0 ? 0.95 : alpha;
      for (let i = 0; i < COLS; i++) {
        const [x, y, v] = pts[i];
        if (v <= 0.03) continue;
        ctx.beginPath(); ctx.arc(x, y, dot, 0, 6.283); ctx.fill();
      }
    }
    const t = vizT, sg = phase === 'SPEAKING' ? 1 : 0.22;
    for (let l = 0; l < 3; l++) {
      ctx.globalAlpha = 0.5 - l * 0.13; ctx.strokeStyle = '#0A0A0A'; ctx.lineWidth = l === 0 ? 1.2 : 0.7;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 3) {
        const u = x / W, env = Math.sin(u * Math.PI) ** 0.7;
        const y = H * 0.88 + Math.sin(u * (14 + l * 9) + t * (2.4 + l)) * H * 0.055 * env * sg + Math.sin(u * 3 - t * 1.1) * H * 0.02 * env * sg;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
  const loop = () => {
    requestAnimationFrame(loop);
    const now = performance.now();
    if (now - lastStep < 15 || !fit()) return;
    lastStep = now;
    try { frame(now); } catch { /* keep alive */ }
  };
  requestAnimationFrame(loop);
})();

// ---------- agent connect (SDK path via deepgram-agent.js) ----------
async function connectAgent(priorContext) {
  $('btnConnect').disabled = true;
  $('btnConnect').textContent = '…';
  try {
    // Warm up audio unlock inside the click gesture (autoplay policy).
    try { const AC = window.AudioContext || window.webkitAudioContext; unlockCtx = unlockCtx || new AC(); await unlockCtx.resume().catch(() => {}); } catch { /* noop */ }
    const detail = (m) => {
      try {
        const s = JSON.stringify(m);
        return s.length > 220 ? s.slice(0, 220) + '…' : s;
      } catch { return String(m); }
    };
    const sessionCfg = fullCfg();
    // Hand the new socket the prior conversation as background context —
    // a refresh gets a new websocket (Deepgram has no cross-socket resume),
    // but the agent can still pick up where the chat left off.
    if (priorContext && priorContext.length) sessionCfg.context = priorContext;
    handle = await startSession(sessionCfg, {
      conversationText: (m) => { addTranscript((m.role || '?').toUpperCase(), m.content || ''); turns++; $('turns').textContent = String(turns).padStart(2, '0'); },
      agentThinking: () => setPhase('THINKING'),
      agentStartedSpeaking: () => setPhase('SPEAKING'),
      userStartedSpeaking: () => setPhase('LISTENING'),
      agentAudioDone: () => setPhase('IDLE'),
      welcome: (m) => logLine('Welcome · ' + String(m.request_id || '').slice(0, 8)),
      settingsApplied: () => logLine('SettingsApplied ✓ agent configured — speak now'),
      connected: () => logLine('connected'),
      disconnected: (r) => logLine('disconnected · ' + detail(r)),
      reconnecting: (a) => logLine('reconnecting · ' + detail(a)),
      error: (m) => logLine('ERROR ' + (m.code || '') + ' · ' + String(m.description || detail(m)).slice(0, 200)),
      warning: (m) => logLine('WARN · ' + detail(m).slice(0, 200)),
      injectionRefused: (m) => logLine('InjectionRefused · ' + String(m.message || detail(m)).slice(0, 160)),
      latencyReport: (m) => logLine(`LatencyReport · ttfb ${m.timetofirstbyte ?? m.time_to_first_byte_ms ?? '?'}ms`),
      history: () => logLine('History restored'),
      functionCallRequest: (m) => logLine('FunctionCallRequest · ' + (m.functions || []).map((f) => f.name).join(',')),
      sdkError: (e) => logLine('SDK-ERR · ' + String(e?.message || e).slice(0, 200)),
      any: (kind, payload) => {
        if (['conversationText','agentThinking','agentStartedSpeaking','userStartedSpeaking','agentAudioDone',
             'welcome','settingsApplied','connected','disconnected','reconnecting','error','warning',
             'injectionRefused','latencyReport','history','functionCallRequest','sdkError'].includes(kind)) return;
        logLine(kind + (payload ? ' · ' + detail(payload).slice(0, 120) : ''));
      },
    });
    window.__dgvox = handle; // console debugging: __dgvox.session, __dgvox.player, __dgvox.mic
    probeAudio();
    setPhase('LISTENING');
    $('btnConnect').textContent = 'DISCONNECT'; $('connPill').textContent = 'LIVE · LISTENING';
    logLine('connect() → agent live');
    saveSession({ live: true });
  } catch (e) {
    logLine('connect failed: ' + (e?.message || e));
    alert('Connect failed: ' + (e?.message || e) + '\nCheck server is running + mic permission.');
    $('btnConnect').textContent = 'CONNECT';
  } finally { $('btnConnect').disabled = false; }
}
$('btnConnect').onclick = () => {
  if (handle) {
    try { handle.stop(); } catch { /* noop */ }
    handle = null; window.__dgvox = null;
    if (audioTick) { clearInterval(audioTick); audioTick = null; }
    setPhase('IDLE');
    $('btnConnect').textContent = 'CONNECT'; $('connPill').textContent = 'IDLE';
    logLine('socket closed');
    saveSession({ live: false }); // explicit disconnect — don't auto-reconnect on next refresh
    return;
  }
  connectAgent();
};
const fullCfg = () => ({ ...cfg, prompt: $('prompt').value, greeting: cfg.greeting });
$('btnInject').onclick = doInject;
$('inject').onkeydown = (e) => { if (e.key === 'Enter') doInject(); };
function doInject() {
  const v = $('inject').value.trim(); if (!v) return;
  $('inject').value = '';
  addTranscript('USER', v); logLine('InjectUserMessage');
  try { handle?.injectUser(v); } catch { /* offline seed */ }
}

// ---------- named session management (save / load / delete / new) ----------
// Separate from SESSION_KEY (which auto-tracks "the current tab's session"
// for refresh-continuity): this is a named library of sessions in
// localStorage, so it survives across tabs/browser restarts and lets you
// keep more than one conversation around.
const SAVED_SESSIONS_KEY = 'dgvox.savedSessions.v1';
function loadSavedSessions() {
  try { return JSON.parse(localStorage.getItem(SAVED_SESSIONS_KEY) || '{}'); } catch { return {}; }
}
function writeSavedSessions(all) {
  try { localStorage.setItem(SAVED_SESSIONS_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}
function refreshSessionSelect(selected) {
  const all = loadSavedSessions();
  const sel = $('sessionSelect');
  const names = Object.keys(all).sort();
  sel.innerHTML = '<option value="">— unsaved session —</option>' + names.map((n) => `<option value="${n}">${n}</option>`).join('');
  sel.value = names.includes(selected) ? selected : '';
}
function renderTranscriptFrom(entries) {
  $('transcript').innerHTML = '';
  (entries || []).forEach((m) => addTranscript(m.role, m.text, { replay: true }));
}
function disconnectIfLive() {
  if (!handle) return;
  try { handle.stop(); } catch { /* noop */ }
  handle = null; window.__dgvox = null;
  if (audioTick) { clearInterval(audioTick); audioTick = null; }
  setPhase('IDLE');
  $('btnConnect').textContent = 'CONNECT'; $('connPill').textContent = 'IDLE';
}
refreshSessionSelect('');
$('sessionSelect').onchange = () => { $('sessionName').value = $('sessionSelect').value; };
$('btnSessionSave').onclick = () => {
  const name = $('sessionName').value.trim();
  if (!name) { logLine('enter a session name before saving'); return; }
  const cur = loadSession() || { transcript: [], turns: 0 };
  const all = loadSavedSessions();
  all[name] = { transcript: cur.transcript || [], turns: cur.turns || 0, savedAt: Date.now() };
  writeSavedSessions(all);
  refreshSessionSelect(name);
  logLine('saved session "' + name + '"');
};
$('btnSessionLoad').onclick = () => {
  const name = $('sessionSelect').value;
  if (!name) { logLine('pick a saved session to load'); return; }
  const saved = loadSavedSessions()[name];
  if (!saved) { logLine('session "' + name + '" not found'); return; }
  disconnectIfLive();
  renderTranscriptFrom(saved.transcript);
  turns = saved.turns || 0; $('turns').textContent = String(turns).padStart(2, '0');
  saveSession({ transcript: saved.transcript || [], turns: saved.turns || 0, live: false });
  $('sessionName').value = name;
  logLine('loaded session "' + name + '" — click CONNECT to go live with this context');
};
$('btnSessionDelete').onclick = () => {
  const name = $('sessionSelect').value;
  if (!name) { logLine('pick a saved session to delete'); return; }
  const all = loadSavedSessions();
  delete all[name];
  writeSavedSessions(all);
  refreshSessionSelect('');
  $('sessionName').value = '';
  logLine('deleted session "' + name + '"');
};
$('btnSessionNew').onclick = () => {
  disconnectIfLive();
  turns = 0; $('turns').textContent = '00';
  const seed = [{ role: 'AGENT', text: 'Channel open. What do you need?', seed: true }];
  renderTranscriptFrom(seed);
  saveSession({ transcript: seed, turns: 0, live: false });
  $('sessionName').value = '';
  $('sessionSelect').value = '';
  logLine('new session started');
};

// ---------- restore a live session across a page refresh ----------
if (savedSession?.live) {
  logLine('restoring live session from before refresh…');
  // Shape must match what the SDK itself pushes into conversationHistory
  // (type: "History", role, content) — a plain {role, content} pair is
  // rejected by Deepgram as UNPARSABLE_CLIENT_MESSAGE on agent.context.messages.
  const priorContext = (savedSession.transcript || [])
    .filter((m) => !m.seed)
    .map((m) => ({ type: 'History', role: m.role === 'USER' ? 'user' : 'assistant', content: m.text }));
  connectAgent(priorContext);
}
$('btnEot').onclick = () => { logLine('ForceEndTurn (not supported by SDK v0.1.2 — no-op)'); try { handle?.forceEndTurn(); } catch { /* noop */ } };
// Barge-in on demand: same path the mic takes on UserStartedSpeaking, minus
// the mic. Purely local — the agent's own transcript still holds the full turn.
$('btnInterrupt').onclick = () => {
  if (!handle) return logLine('interrupt — not connected');
  logLine(handle.interrupt() ? 'interrupt — agent audio cut' : 'interrupt — failed');
};
$('btnSpk').onclick = async () => {
  logLine('speaker test → /api/tts …');
  try {
    const r = await fetch('/api/tts?model=aura-2-thalia-en', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Speaker test. If you hear this, your device audio works.' }),
    });
    if (!r.ok) { logLine('speaker test FAILED · TTS ' + r.status); return; }
    const url = URL.createObjectURL(await r.blob());
    const el = new Audio(url);
    await el.play();
    logLine('speaker test PLAYING — if silent, check device volume / silent switch');
  } catch (e) { logLine('speaker test FAILED · ' + String(e?.message || e).slice(0, 160)); }
};
$('btnPrompt').onclick = () => {
  const p = $('prompt').value;
  try { handle?.updatePrompt(p); logLine('UpdatePrompt → live'); }
  catch { logLine('UpdatePrompt → queued (offline)'); }
  renderSettings();
};

// ---------- TAB 2: simple voice ----------
let rec = null, chunks = [];
$('btnRec').onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    rec = new MediaRecorder(s); chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      s.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      await sendStt(blob, blob.type);
      $('btnRec').disabled = false; $('btnStopRec').disabled = true;
      $('btnRec').textContent = '● RECORD';
    };
    rec.start();
    $('btnRec').disabled = true; $('btnStopRec').disabled = false;
    $('btnRec').textContent = '● REC…';
  } catch { $('sttOut').textContent = 'mic denied'; }
};
$('btnStopRec').onclick = () => rec?.stop();
$('btnFileStt').onclick = async () => {
  const f = $('sttFile').files?.[0];
  if (!f) { $('sttOut').textContent = 'pick a file first'; return; }
  await sendStt(f, f.type || 'audio/wav');
};
async function sendStt(blob, ct) {
  $('sttOut').textContent = '… transcribing …';
  const q = new URLSearchParams({ model: $('sttModel').value, smart_format: $('sttSmart').checked, diarize: $('sttDiarize').checked }).toString();
  try {
    const r = await fetch('/api/stt?' + q, { method: 'POST', headers: { 'Content-Type': ct }, body: blob });
    const j = await r.json();
    const alt = j?.results?.channels?.[0]?.alternatives?.[0];
    $('sttOut').textContent = (alt?.transcript || '(empty)') + `\n\n— model ${$('sttModel').value} · conf ${alt?.confidence?.toFixed?.(3) ?? '?'} —\n` + JSON.stringify(j.results?.channels?.[0]?.alternatives?.slice(0, 1), null, 2);
  } catch (e) { $('sttOut').textContent = 'STT error: ' + (e?.message || e); }
}
$('btnSpeak').onclick = async () => {
  const text = $('ttsText').value.trim();
  if (!text) return;
  $('ttsOut').textContent = '… synthesizing …';
  try {
    const r = await fetch('/api/tts?model=' + encodeURIComponent($('ttsModel').value), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) { $('ttsOut').textContent = 'TTS ' + r.status + ': ' + (await r.text()).slice(0, 500); return; }
    const blob = await r.blob();
    $('ttsAudio').src = URL.createObjectURL(blob);
    await $('ttsAudio').play().catch(() => {});
    $('ttsOut').textContent = `ok · ${$('ttsModel').value} · ${(blob.size / 1024).toFixed(1)} KB · ${r.headers.get('content-type')}`;
  } catch (e) { $('ttsOut').textContent = 'TTS error: ' + (e?.message || e); }
};

// ---------- TAB 3: text intel ----------
$('btnSample').onclick = () => {
  $('intelText').value = 'Thank you for calling Premier Phone Services, this is Dana. How can I help? Hi, I am calling to get a refund on my recent purchase, the screen broke after two days and I am really frustrated. Sure, I would be happy to help with that refund. What was the order number? It is order 88412, placed online last week. Thanks, I see it, this was an online purchase and I have started the refund. You should see it in three days. That is great, thank you so much, you have been very helpful!';
};
$('btnAnalyze').onclick = async () => {
  const text = $('intelText').value.trim();
  if (!text) return;
  $('intelSummary').textContent = $('intelSent').textContent = $('intelTopics').textContent = '… analyzing …';
  const q = new URLSearchParams({
    summarize: $('fSum').checked, sentiment: $('fSent').checked,
    topics: $('fTop').checked, intents: $('fInt').checked, language: 'en',
  }).toString();
  try {
    const r = await fetch('/api/read?' + q, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const j = await r.json();
    if (!r.ok) { $('intelRaw').textContent = JSON.stringify(j, null, 2); return; }
    $('intelRaw').textContent = JSON.stringify(j, null, 2).slice(0, 6000);
    $('intelSummary').textContent = j?.results?.summary?.text || '(no summary — enable summarize)';
    const s = j?.results?.sentiments;
    $('intelSent').textContent = s
      ? `average: ${s.average?.sentiment} (${Number(s.average?.sentiment_score).toFixed(3)})\n` + (s.segments || []).map((g) => `· [${g.sentiment} ${Number(g.sentiment_score).toFixed(2)}] ${g.text}`).join('\n')
      : '(no sentiment — enable sentiment)';
    const t = j?.results?.topics?.segments || [];
    const it = j?.results?.intents?.segments || [];
    $('intelTopics').textContent =
      (t.length ? t.map((g) => `“${g.text.slice(0, 90)}…”\n  → ` + (g.topics || []).map((x) => `${x.topic} (${Number(x.confidence_score).toFixed(2)})`).join(', ')).join('\n\n') : '(no topics)') +
      '\n\nINTENTS:\n' + (it.length ? it.map((g) => `“${g.text.slice(0, 90)}…”\n  → ` + (g.intents || []).map((x) => `${x.intent} (${Number(x.confidence_score).toFixed(2)})`).join(', ')).join('\n\n') : '(no intents)');
  } catch (e) {
    $('intelRaw').textContent = 'error: ' + (e?.message || e);
  }
};
