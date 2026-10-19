# DG//VOX — Deepgram Voice Console

Multi-tab browser console for Deepgram: a live **Voice Agent** (speech in,
speech out, with tool calling), **Simple Voice** (STT + TTS) and **Text
Intelligence**. A small Express server holds your API key and proxies all
Deepgram traffic — the browser never sees the key.

## Tabs

| Tab | Route | Deepgram API |
|---|---|---|
| **AGENT · HOME** (default) | `/` → `#tab-agent` | Voice Agent `wss://agent.deepgram.com/v1/agent/converse` via `deepgram-agent.js` `startSession()` + token proxy |
| **SIMPLE VOICE** | `#tab-simple` | STT `POST /v1/listen` (mic record + file upload) · TTS `POST /v1/speak` (Aura-2 + Flux voices) |
| **TEXT INTEL** | `#tab-intel` | `POST /v1/read?summarize&sentiment&topics&intents` with summary/sentiment/topics rendering |

## 1. Set your Deepgram API key

Get a key at <https://console.deepgram.com>. Set it once as an OS
environment variable — no `.env` file needed.

**Linux / macOS** — add to `~/.bashrc` (or `~/.bash_profile` / `~/.profile`):

```bash
export DEEPGRAM_API_KEY="your_key_here"
```

then `source ~/.bashrc`.

**Windows** — in PowerShell or cmd:

```powershell
setx DEEPGRAM_API_KEY "your_key_here"
```

`setx` only affects terminals opened *afterwards*, but the server also reads
the value straight from the registry, so it works even in an already-open
terminal.

Lookup order (see `env.js`): process environment → `~/.bashrc`/`~/.bash_profile`/`~/.profile`
(Linux/macOS) or `HKCU\Environment` / machine env via `setx /M` (Windows)
→ optional `.env` file (copy `.env.example`). Optional extras:
`DEEPGRAM_V2_API_KEY` (secondary key), `DEEPGRAM_BASE_URL`, `PORT`, `HOST`.

On startup the server logs which source the key came from:

```
primary key: set (abcd…, from shell rc file) | secondary: missing
```

## 2. Run

Requires Node.js 18+.

```bash
npm install
npm run build   # bundle @deepgram/agents for the browser
npm start       # http://localhost:8787
```

## Agent tools & security

The voice agent can call server-side tools (`agent-tools.js`, `server.js`):

- **Browser** — navigate / read / click / type / tabs, by attaching over CDP to
  a Chromium you start with `--remote-debugging-port=9223`
  (override with `DGVOX_CDP_URL`).
- **Files** — list/read text files under your home directory (hidden files and
  secret-looking names blocked).
- **Shell** — runs arbitrary commands (`bash` on Linux/macOS, PowerShell on Windows).
- **Graph** — drives an optional graph-ctl app (`DGVOX_GRAPH_DIR`).

These routes are **unauthenticated**, so the server binds to `127.0.0.1` by
default. Only set `HOST=0.0.0.0` on a network you fully trust (e.g. a private
Tailscale tailnet) — anyone who can reach the port gets a shell as you.

> **Why `npm run build`?** The browser must NOT load `@deepgram/agents`
> from esm.sh — its Node-only `ws` dependency throws
> `does not provide an export named 'WebSocket'`. Instead
> `public/deepgram-agent.js` statically imports the locally installed
> `@deepgram/agents@0.1.2` and esbuild bundles it (platform=browser) to
> `public/deepgram-agent.bundle.js`, which is what `app.js` imports.
> Re-run `npm run build` after editing `deepgram-agent.js`.
> Auth detail: the SDK sends the `/v1/auth/grant` JWT as WebSocket
> subprotocol `["bearer", <jwt>]` (raw API keys use `["token", <key>]`).

## Backend routes

- `POST /api/deepgram/token` → `POST /v1/auth/grant` (300s TTL), returns plain-text JWT.
  `deepgram-agent.js` `fetchToken()` already points here.
- `POST /api/stt?model=nova-3&smart_format=true&diarize=false` — raw audio body, forwards to `/v1/listen`.
- `POST /api/tts?model=aura-2-thalia-en` + `{"text":"…"}` — forwards to `/v1/speak`, returns audio bytes.
- `POST /api/read?summarize=true&sentiment=true&topics=true&intents=true&language=en` + `{"text":"…"}` — forwards to `/v1/read`.
- `GET /api/health`, `GET /api/config`, `POST /api/agent/functions/:name` (demo `lookup_record` / `get_weather`).

## Verified live (2026-09-13)

- `/api/deepgram/token` → JWT ✓
- `/api/read` (all 4 flags) → summary + sentiments + topics + intents ✓
- `/api/tts` (aura-2-thalia-en) → 18 KB MP3 ✓
- `/api/stt` (nova-3, Bueller wav) → correct transcript ✓
- **Agent back-and-forth** via real SDK (`AgentSession` + our
  `buildAgentConfig`): `SettingsApplied` → inject user text → assistant
  `ConversationText` reply + 57.6 KB TTS audio + `agent-audio-done` ✓

> Bug found & fixed 2026-09-13: the default `lookup_record` plugin
> emitted a **relative** server-side `endpoint.url`
> (`/api/agent/functions/...`), which made Deepgram reject the whole
> Settings message (`UNPARSABLE_CLIENT_MESSAGE` on `agent.think`) — the
> agent connected but never thought or spoke. `functionDefs()` now only
> emits absolute-URL endpoints; the demo plugins run client-side.

## Docs researched

- Agent config: https://developers.deepgram.com/docs/configure-voice-agent
- Inputs/outputs: …/docs/voice-agent-inputs, …/docs/voice-agent-outputs
- Browser SDK: …/docs/browser-agent-javascript · Function calling: …/docs/voice-agents-function-calling
- TTS REST, STT listen, Analyze Text (`/v1/read`): …/reference/text-intelligence/analyze-text
