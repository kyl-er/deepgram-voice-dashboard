/**
 * Resolve Deepgram settings from the OS environment, so no .env file is needed.
 *
 * Lookup order for each variable (first hit wins):
 *   1. process.env — covers `export X=...` in ~/.bashrc (when started from a
 *      shell) and Windows `setx X ...` (in any terminal opened after setx).
 *   2. Linux/macOS: `export X=...` / `X=...` lines in ~/.bashrc, ~/.bash_profile,
 *      ~/.profile — for launches that skip the interactive shell (systemd, IDEs).
 *   3. Windows: the user registry (HKCU\Environment, where `setx` writes) and
 *      the machine registry (`setx /M`) — for terminals opened before setx.
 *   4. An optional .env file in the project root (loaded by server.js).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const VARS = ['DEEPGRAM_API_KEY', 'DEEPGRAM_V2_API_KEY', 'DEEPGRAM_BASE_URL'];

function fromShellRc(name) {
  for (const f of ['.bashrc', '.bash_profile', '.profile']) {
    let text;
    try { text = fs.readFileSync(path.join(os.homedir(), f), 'utf8'); } catch { continue; }
    const re = new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`, 'm');
    const m = text.match(re);
    if (m) return m[1].trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
}

function fromWindowsRegistry(name) {
  for (const key of ['HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)`));
      if (m) return m[1].trim();
    } catch { /* not set in this hive */ }
  }
  return '';
}

export function loadEnv() {
  const sources = {};
  for (const name of VARS) {
    if (process.env[name]) { sources[name] = 'environment'; continue; }
    const value = process.platform === 'win32' ? fromWindowsRegistry(name) : fromShellRc(name);
    if (value) {
      process.env[name] = value;
      sources[name] = process.platform === 'win32' ? 'registry (setx)' : 'shell rc file';
    }
  }
  return sources;
}

export const ENV_SOURCES = loadEnv();
