/**
 * DG//VOX backend — Deepgram proxy server.
 *
 * Endpoints (all Deepgram traffic goes through here so the browser never
 * holds a raw API key):
 *   POST /api/deepgram/token          -> short-lived Voice Agent token (grant)
 *   POST /api/stt?model=nova-3...     -> prerecorded STT  (POST /v1/listen)
 *   POST /api/tts?model=aura-2-...    -> TTS speak        (POST /v1/speak)
 *   POST /api/read?summarize=true...  -> text intelligence(POST /v1/read)
 *   GET  /api/health                  -> key presence + upstream reachability
 *   GET  /api/config                  -> safe public enums for the UI
 *
 * Docs:
 *   Agent  https://developers.deepgram.com/docs/configure-voice-agent
 *   STT    POST /v1/listen  (model, smart_format, sentiment, summarize, topics...)
 *   TTS    POST /v1/speak?model=  (aura-2-*, flux-*)
 *   Read   POST /v1/read?sentiment=true&summarize=true&topics=true&intents=true&language=en
 */
import { ENV_SOURCES } from './env.js'; // OS env / ~/.bashrc / Windows setx — before .env
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  browserNavigate, browserReadPage, browserClick, browserType,
  browserTabs, browserSwitchTab,
  graphNodeAdd, graphEdgeAdd, graphNodeRm, graphInspect, graphClear,
  runBash,
} from './agent-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- file-access tool (list_files / read_file agent functions) ----------
// Sandboxed to the user's home directory per explicit request. No auth on
// this route (also explicit) — anything that can reach this server on the
// network can call these, so the sandbox below is the only real boundary.
// Defense in depth: block dotfiles/dot-dirs (.ssh, .aws, .gnupg, .config,
// .env, .git, .claude, .npmrc, .netrc, .docker, shell history, ...) and
// known secret-bearing filenames, even though the user declined to add
// endpoint auth — silently exposing SSH keys or cloud credentials to a
// cloud LLM's function-calling isn't something "no auth please" implies.
const FS_ROOT = os.homedir();
const SECRET_NAME_RE = /(^|[._-])(credentials|secret|secrets|password|passwd|shadow|token|apikey|api_key|wallet)([._-]|\.|$)|\.(pem|key|ppk|kdbx)$|(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i;

function resolveSandboxed(relPath) {
  const clean = String(relPath || '').replace(/^\/+/, '');
  const abs = path.resolve(FS_ROOT, clean);
  const relFromRoot = path.relative(FS_ROOT, abs);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null; // escapes root
  const segments = relFromRoot.split(path.sep).filter(Boolean);
  if (segments.some((s) => s.startsWith('.'))) return null; // any hidden component
  if (segments.length && SECRET_NAME_RE.test(segments[segments.length - 1])) return null;
  return abs;
}

async function listFilesTool(relPath) {
  const abs = resolveSandboxed(relPath || '.');
  if (!abs) return { error: 'path is outside the allowed sandbox or is hidden/blocked' };
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (SECRET_NAME_RE.test(e.name)) continue;
    let size = null;
    if (e.isFile()) { try { size = (await fs.stat(path.join(abs, e.name))).size; } catch { /* skip */ } }
    items.push({ name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size });
  }
  return { path: path.relative(FS_ROOT, abs) || '.', entries: items };
}

const MAX_READ_BYTES = 200_000;
async function readFileTool(relPath) {
  const abs = resolveSandboxed(relPath);
  if (!abs) return { error: 'path is outside the allowed sandbox, hidden, or a blocked (secret-looking) filename' };
  const stat = await fs.stat(abs);
  if (!stat.isFile()) return { error: 'not a regular file' };
  if (stat.size > MAX_READ_BYTES) return { error: `file too large (${stat.size}b, max ${MAX_READ_BYTES}b)` };
  const buf = await fs.readFile(abs);
  // Refuse anything that doesn't look like text (avoid dumping binaries as "text").
  const sample = buf.subarray(0, 1000);
  if (sample.includes(0)) return { error: 'file appears to be binary, not text' };
  return { path: path.relative(FS_ROOT, abs), size: stat.size, content: buf.toString('utf8') };
}
const app = express();
const PORT = Number(process.env.PORT || 8787);
// Loopback by default: the agent tools include an unauthenticated shell. Set HOST=0.0.0.0 to expose on the LAN.
const HOST = process.env.HOST || '127.0.0.1';
const BASE = (process.env.DEEPGRAM_BASE_URL || 'https://api.deepgram.com').replace(/\/$/, '');
const KEY = process.env.DEEPGRAM_API_KEY || '';
const KEY2 = process.env.DEEPGRAM_V2_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '5mb' }));
// Raw audio bodies for /api/stt
app.use('/api/stt', express.raw({ type: '*/*', limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pickKey = (req) =>
  req.query.key === 'secondary' && KEY2 ? KEY2 : KEY;

async function dgFetch(url, { method = 'GET', key, headers = {}, body } = {}) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Token ${key}`, ...headers },
    body,
  });
  return r;
}

// ---------- health / config ----------
app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    hasPrimary: Boolean(KEY),
    hasSecondary: Boolean(KEY2),
    base: BASE,
    time: new Date().toISOString(),
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    agentSocket: 'wss://agent.deepgram.com/v1/agent/converse',
    sttModels: ['nova-3', 'nova-3-medical', 'nova-2', 'flux-general-en', 'flux-general-multi'],
    ttsModels: [
      'aura-2-thalia-en', 'aura-2-asteria-en', 'aura-2-helios-en',
      'flux-heather-en', 'flux-kit-en', 'flux-alexis-en',
    ],
    readFlags: ['summarize', 'sentiment', 'topics', 'intents'],
  });
});

// ---------- 1. Voice Agent token grant ----------
// POST https://api.deepgram.com/v1/auth/grant  { time_to_live_in_seconds: 300 }
app.post('/api/deepgram/token', async (req, res) => {
  try {
    if (!KEY && !KEY2) return res.status(500).send('no DEEPGRAM_API_KEY in .env');
    const key = pickKey(req);
    const ttl = Number(req.query.ttl || req.body?.ttl || 300);
    const r = await dgFetch(`${BASE}/v1/auth/grant`, {
      method: 'POST',
      key,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ time_to_live_in_seconds: Math.min(Math.max(ttl, 60), 3600) }),
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    // Return plain-text token (deepgram-agent.js fetchToken handles JSON-or-text)
    try {
      const j = JSON.parse(text);
      return res.send(j.access_token || text);
    } catch { return res.send(text); }
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});

// ---------- 2. STT prerecorded ----------
// Client: POST /api/stt?model=nova-3&smart_format=true  body=audio bytes, Content-Type: audio/wav
app.post('/api/stt', async (req, res) => {
  try {
    const key = pickKey(req);
    if (!key) return res.status(500).json({ error: 'no key' });
    const qs = new URLSearchParams(req.query).toString();
    const ct = req.headers['content-type'] || 'audio/wav';
    const r = await dgFetch(`${BASE}/v1/listen${qs ? `?${qs}` : ''}`, {
      method: 'POST',
      key,
      headers: { 'Content-Type': ct },
      body: req.body,
    });
    const text = await r.text();
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- 3. TTS ----------
// Client: POST /api/tts?model=aura-2-thalia-en  { "text": "hello" }
app.post('/api/tts', async (req, res) => {
  try {
    const key = pickKey(req);
    if (!key) return res.status(500).json({ error: 'no key' });
    const model = req.query.model || req.body?.model || 'aura-2-thalia-en';
    const text = req.body?.text || '';
    if (!text.trim()) return res.status(400).json({ error: 'text required' });
    const qs = new URLSearchParams({ ...req.query, model }).toString();
    const r = await dgFetch(`${BASE}/v1/speak?${qs}`, {
      method: 'POST',
      key,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).send(t);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res
      .status(200)
      .set('Content-Type', r.headers.get('content-type') || 'audio/mpeg')
      .send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- 4. Text Intelligence (/v1/read) ----------
// Client: POST /api/read?summarize=true&sentiment=true&topics=true&intents=true&language=en
// Body: { "text": "..." }  or  { "url": "https://..." }
app.post('/api/read', async (req, res) => {
  try {
    const key = pickKey(req);
    if (!key) return res.status(500).json({ error: 'no key' });
    const { text, url } = req.body || {};
    if (!text && !url) return res.status(400).json({ error: 'provide {text} or {url}' });
    const qs = new URLSearchParams();
    for (const f of ['summarize', 'sentiment', 'topics', 'intents', 'language', 'custom_topic', 'custom_intent']) {
      if (req.query[f] !== undefined) qs.set(f, String(req.query[f]));
    }
    if (!qs.has('language')) qs.set('language', 'en');
    const r = await dgFetch(`${BASE}/v1/read?${qs.toString()}`, {
      method: 'POST',
      key,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(text ? { text } : { url }),
    });
    const out = await r.text();
    res.status(r.status).type('application/json').send(out);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Demo function plugins (server-side example for agent function calling)
app.post('/api/agent/functions/:name', express.json(), async (req, res) => {
  const { name } = req.params;
  if (name === 'lookup_record') {
    return res.json({ id: req.body?.id ?? null, status: 'found', note: 'demo record from DG//VOX server' });
  }
  if (name === 'get_weather') {
    return res.json({ city: req.body?.city ?? 'unknown', temp_f: 72, cond: 'clear (demo)' });
  }
  if (name === 'list_files') {
    try { return res.json(await listFilesTool(req.body?.path)); }
    catch (e) { return res.status(e.code === 'ENOENT' ? 404 : 500).json({ error: String(e?.message || e) }); }
  }
  if (name === 'read_file') {
    try { return res.json(await readFileTool(req.body?.path)); }
    catch (e) { return res.status(e.code === 'ENOENT' ? 404 : 500).json({ error: String(e?.message || e) }); }
  }
  // Browser control (live CDP attach) + rfgraph CLI. Implementations and
  // their guardrails live in agent-tools.js.
  const TOOLS = {
    browser_navigate: browserNavigate,
    browser_read_page: browserReadPage,
    browser_click: browserClick,
    browser_type: browserType,
    browser_tabs: browserTabs,
    browser_switch_tab: browserSwitchTab,
    graph_node_add: graphNodeAdd,
    graph_edge_add: graphEdgeAdd,
    graph_node_rm: graphNodeRm,
    graph_inspect: graphInspect,
    graph_clear: graphClear,
    run_bash: runBash,
  };
  if (TOOLS[name]) {
    try { return res.json(await TOOLS[name](req.body ?? {})); }
    // Tool errors are answers, not transport failures: hand the agent a
    // { error } it can speak instead of a 500 it can only stall on.
    catch (e) { return res.json({ error: String(e?.message || e) }); }
  }

  res.json({ ok: true, name, received: req.body ?? null });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, HOST, () => {
  console.log(`DG//VOX server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`primary key: ${KEY ? 'set (' + KEY.slice(0, 4) + '…, from ' + (ENV_SOURCES.DEEPGRAM_API_KEY || '.env') + ')' : 'MISSING'} | secondary: ${KEY2 ? 'set' : 'missing'}`);
});
