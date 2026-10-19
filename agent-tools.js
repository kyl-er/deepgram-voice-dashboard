/**
 * DG//VOX agent tools — live browser control + rfgraph CLI.
 *
 * Both are dispatched from server.js's POST /api/agent/functions/:name, the
 * same route the sandboxed list_files / read_file tools use.
 *
 * Browser: attaches over CDP to the Chrome the user already has running
 * (--remote-debugging-port=9223), so the agent drives the real, logged-in
 * session rather than a blank automation profile.
 *
 * Graph:  shells out to the rfgraph CLI in ~/Projects/graph-ctl. The FastAPI
 * server on :8000 is read-only for mutations (it exposes /graph, /save,
 * /clear, /snapshots, /load, /ws but no node/edge add), so the CLI is the
 * only write path. One call = one node/edge = one visual pulse, per SKILL.md.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ *
 * BROWSER — live CDP attach
 * ------------------------------------------------------------------ */

const CDP_URL = process.env.DGVOX_CDP_URL || 'http://127.0.0.1:9223';
const MAX_PAGE_TEXT = 6000;

let browser = null;   // playwright Browser (CDP-attached)
let agentPage = null; // the tab the agent is currently acting on

/** Attach lazily; re-attach if Chrome was restarted under us. */
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.connectOverCDP(CDP_URL);
  agentPage = null;
  return browser;
}

/**
 * The tab the agent works in. Opens one on first use and reuses it; if the
 * user closes it, the next call transparently opens a fresh one.
 */
async function getPage() {
  const b = await getBrowser();
  if (agentPage && !agentPage.isClosed()) return agentPage;
  const context = b.contexts()[0];
  if (!context) throw new Error('no browser context available over CDP');
  agentPage = await context.newPage();
  return agentPage;
}

// Only ever drive real web pages. file:// would hand the model the whole
// filesystem outside the list_files/read_file sandbox, and chrome:// pages
// reach settings and installed extensions.
function assertNavigable(url) {
  let u;
  try { u = new URL(String(url)); }
  catch { throw new Error(`not a valid URL: ${url}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`refused scheme ${u.protocol} — only http(s) is allowed`);
  }
  return u.toString();
}

const pageSummary = async (page) => ({ url: page.url(), title: await page.title().catch(() => '') });

export async function browserNavigate({ url } = {}) {
  const target = assertNavigable(url);
  const page = await getPage();
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return pageSummary(page);
}

export async function browserReadPage() {
  const page = await getPage();
  const text = await page.evaluate(() => document.body?.innerText || '');
  const clean = text.replace(/\n{3,}/g, '\n\n').trim();
  return {
    ...(await pageSummary(page)),
    truncated: clean.length > MAX_PAGE_TEXT,
    text: clean.slice(0, MAX_PAGE_TEXT),
  };
}

/**
 * Click by visible text (what a voice user actually says), falling back to
 * treating the string as a CSS selector.
 */
export async function browserClick({ text } = {}) {
  if (!text || !String(text).trim()) return { error: 'text required' };
  const page = await getPage();
  const target = String(text).trim();
  try {
    await page.getByText(target, { exact: false }).first().click({ timeout: 8000 });
  } catch {
    try {
      await page.click(target, { timeout: 5000 });
    } catch (e) {
      return { error: `nothing clickable matched ${JSON.stringify(target)}` };
    }
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  return { clicked: target, ...(await pageSummary(page)) };
}

export async function browserType({ text, selector, submit } = {}) {
  if (text === undefined) return { error: 'text required' };
  const page = await getPage();
  const field = selector
    ? page.locator(selector).first()
    // No selector: the focused element if there is one, else the first
    // plausible text input on the page.
    : page.locator('input:not([type=hidden]):not([type=submit]), textarea, [contenteditable=true]').first();
  try {
    await field.fill(String(text), { timeout: 8000 });
  } catch (e) {
    return { error: `could not type into ${selector || 'any input on the page'}` };
  }
  if (submit) {
    await field.press('Enter').catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  }
  return { typed: String(text), submitted: Boolean(submit), ...(await pageSummary(page)) };
}

export async function browserTabs() {
  const b = await getBrowser();
  const pages = b.contexts().flatMap((c) => c.pages());
  const tabs = [];
  for (const [i, p] of pages.entries()) {
    tabs.push({
      index: i,
      url: p.url(),
      title: await p.title().catch(() => ''),
      active: p === agentPage,
    });
  }
  return { count: tabs.length, tabs };
}

/** Point the agent at one of the user's already-open tabs. */
export async function browserSwitchTab({ index } = {}) {
  const b = await getBrowser();
  const pages = b.contexts().flatMap((c) => c.pages());
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= pages.length) {
    return { error: `tab index out of range (0..${pages.length - 1})` };
  }
  agentPage = pages[i];
  await agentPage.bringToFront().catch(() => {});
  return { switchedTo: i, ...(await pageSummary(agentPage)) };
}

/* ------------------------------------------------------------------ *
 * GRAPH — rfgraph CLI
 * ------------------------------------------------------------------ */

const GRAPH_DIR = process.env.DGVOX_GRAPH_DIR || path.join(os.homedir(), 'Projects', 'graph-ctl');
// Call the venv entry point directly rather than via `uv run` — uv re-resolves
// the environment on every invocation, and these calls are meant to fire in
// quick succession as visible pulses in the React Flow view.
const RFGRAPH_BIN = process.env.DGVOX_RFGRAPH_BIN || `${GRAPH_DIR}/.venv/bin/rfgraph`;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function assertId(value, field) {
  const id = String(value ?? '').trim();
  if (!ID_RE.test(id)) {
    throw new Error(`${field} must be a short id like "auth_api" (letters, digits, _ . -)`);
  }
  return id;
}

// Labels are free text from a speech transcript, so they only need to be
// bounded and single-line. execFile passes argv directly — no shell, so no
// quoting or injection concern beyond that.
const cleanText = (value, max = 120) =>
  String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

async function rfgraph(args) {
  try {
    const { stdout } = await execFileAsync(RFGRAPH_BIN, args, {
      cwd: GRAPH_DIR,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const out = stdout.trim();
    try { return JSON.parse(out); } catch { return { ok: true, output: out }; }
  } catch (e) {
    return { error: String(e?.stderr || e?.message || e).slice(0, 500) };
  }
}

export async function graphNodeAdd({ id, label, type } = {}) {
  const nodeId = assertId(id, 'id');
  const args = ['node', 'add', nodeId];
  if (label) args.push('--label', cleanText(label));
  if (type) args.push('--type', cleanText(type, 32));
  return rfgraph(args);
}

export async function graphEdgeAdd({ source, target, label, type } = {}) {
  const args = ['edge', 'add', assertId(source, 'source'), assertId(target, 'target')];
  if (label) args.push('--label', cleanText(label, 48));
  if (type) args.push('--type', cleanText(type, 32));
  return rfgraph(args);
}

export async function graphNodeRm({ id } = {}) {
  return rfgraph(['node', 'rm', assertId(id, 'id')]);
}

export async function graphInspect() {
  const data = await rfgraph(['inspect', '--json']);
  if (data?.error) return data;
  // Voice agents choke on a full graph dump — summarize, list ids only.
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: nodes.slice(0, 60).map((n) => ({ id: n.id, label: n.label, type: n.type })),
    edges: edges.slice(0, 60).map((e) => ({ from: e.source, to: e.target, label: e.label })),
  };
}

export async function graphClear() {
  return rfgraph(['clear']);
}

/* ------------------------------------------------------------------ *
 * SHELL — unrestricted, by explicit request
 * ------------------------------------------------------------------ */
// No whitelist: this runs whatever the model asks for as the logged-in user.
// The route in front of it is unauthenticated, and browser_read_page /
// read_file can feed attacker-controlled text into the same model, so treat
// a running session as equivalent to an open shell on this machine.
const MAX_OUT = 12_000;

export async function runBash({ command, cwd, timeout_ms } = {}) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return { error: 'command required' };
  const opts = {
    cwd: cwd ? String(cwd).replace(/^~/, os.homedir()) : os.homedir(),
    timeout: Math.min(Math.max(Number(timeout_ms) || 30_000, 1000), 120_000),
    maxBuffer: 8 * 1024 * 1024,
  };
  try {
    const { stdout, stderr } = await (process.platform === 'win32'
      ? execFileAsync('powershell.exe', ['-NoProfile', '-Command', cmd], opts)
      : execFileAsync('/bin/bash', ['-lc', cmd], opts));
    const out = (stdout || '').trim();
    return {
      exit_code: 0,
      stdout: out.slice(0, MAX_OUT),
      truncated: out.length > MAX_OUT,
      ...(stderr?.trim() ? { stderr: stderr.trim().slice(0, 2000) } : {}),
    };
  } catch (e) {
    return {
      exit_code: e?.code ?? 1,
      error: e?.killed ? 'command timed out' : 'command failed',
      stdout: String(e?.stdout || '').trim().slice(0, MAX_OUT),
      stderr: String(e?.stderr || e?.message || '').trim().slice(0, 2000),
    };
  }
}
