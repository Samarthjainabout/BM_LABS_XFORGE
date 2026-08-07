#!/usr/bin/env node
// server.js — codex-agent GUI backend. Same providers/tools/hardware
// capabilities as the CLI edition, but exposes them over a small local
// HTTP + Server-Sent-Events API instead of a terminal loop, so the
// launcher can open a real windowed app instead of Terminal.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let ROOT = process.cwd();

// =========================================================================
// .env loader
// =========================================================================
function loadEnv() {
  const envPath = path.resolve(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const BAKED_IN_OPENROUTER_KEY = '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';
if (!process.env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = BAKED_IN_OPENROUTER_KEY;

// =========================================================================
// Providers
// =========================================================================
const PROVIDERS = {
  openrouter: { label: 'OpenRouter', kind: 'openai-chat', baseURL: 'https://openrouter.ai/api/v1/chat/completions', apiKeyEnv: 'OPENROUTER_API_KEY', defaultModel: 'openai/gpt-4o-mini', extraHeaders: { 'HTTP-Referer': 'https://local.codex-agent', 'X-Title': 'codex-agent' } },
  openai: { label: 'OpenAI', kind: 'openai-chat', baseURL: 'https://api.openai.com/v1/chat/completions', apiKeyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4o-mini' },
  groq: { label: 'Groq', kind: 'openai-chat', baseURL: 'https://api.groq.com/openai/v1/chat/completions', apiKeyEnv: 'GROQ_API_KEY', defaultModel: 'llama-3.3-70b-versatile' },
  anthropic: { label: 'Anthropic', kind: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1/messages', apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-6' },
  ollama: { label: 'Ollama (local)', kind: 'openai-chat', baseURL: 'http://localhost:11434/v1/chat/completions', apiKeyEnv: null, defaultModel: 'llama3.1' }
};

(function loadLocalProviders() {
  const p = path.join(ROOT, 'providers.local.json');
  if (!fs.existsSync(p)) return;
  try {
    const extra = JSON.parse(fs.readFileSync(p, 'utf-8'));
    for (const [name, def] of Object.entries(extra)) {
      if (name.startsWith('_')) continue;
      if (!def.baseURL || !def.kind) continue;
      PROVIDERS[name] = { label: def.label || name, apiKeyEnv: null, ...def };
    }
  } catch (err) { console.error(`⚠ Could not parse providers.local.json: ${err.message}`); }
})();

function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown provider "${name}"`);
  return p;
}
function getApiKey(provider) {
  if (provider.apiKey) return provider.apiKey;
  if (!provider.apiKeyEnv) return null;
  const key = process.env[provider.apiKeyEnv];
  if (!key) throw new Error(`Missing API key. Set ${provider.apiKeyEnv} in your .env file.`);
  return key;
}

let providerName = process.env.DEFAULT_PROVIDER || 'openrouter';
let provider = getProvider(providerName);
let model = process.env.DEFAULT_MODEL || provider.defaultModel;

// Three approval modes, switchable at runtime from the UI (not just a startup flag):
//   'full'     — never ask, execute every tool call immediately (old --yolo behavior)
//   'approve'  — ask before every destructive tool call (default)
//   'readonly' — destructive tools aren't even offered to the model; it can read/inspect but never write, run commands, flash, or capture
let approvalMode = process.argv.includes('--yolo') ? 'full' : 'approve';
const VALID_MODES = new Set(['full', 'approve', 'readonly']);

// =========================================================================
// Core tools
// =========================================================================
function resolveSafe(p) { return path.resolve(ROOT, p); }

const CORE_TOOL_DEFS = [
  { type: 'function', function: { name: 'read_file', description: 'Read the full contents of a text file at a given path.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file with the given content. Creates parent directories if needed.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace an exact, unique substring in a file with new text.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } } },
  { type: 'function', function: { name: 'list_dir', description: 'List files and folders in a directory (non-recursive).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a shell command in the terminal and return stdout/stderr.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'system_info', description: 'Get system/hardware info: CPU, memory, platform, uptime, network interfaces, disk usage.', parameters: { type: 'object', properties: {}, required: [] } } }
];
const DESTRUCTIVE_TOOLS = new Set(['write_file', 'edit_file', 'run_command']);

async function runCoreTool(name, args) {
  switch (name) {
    case 'read_file': return { ok: true, content: await fsp.readFile(resolveSafe(args.path), 'utf-8') };
    case 'write_file': {
      const p = resolveSafe(args.path);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, args.content, 'utf-8');
      return { ok: true, message: `Wrote ${args.content.length} bytes to ${p}` };
    }
    case 'edit_file': {
      const p = resolveSafe(args.path);
      const original = await fsp.readFile(p, 'utf-8');
      const count = original.split(args.old_text).length - 1;
      if (count === 0) return { ok: false, error: 'old_text not found in file' };
      if (count > 1) return { ok: false, error: `old_text is not unique (${count} matches)` };
      await fsp.writeFile(p, original.replace(args.old_text, args.new_text), 'utf-8');
      return { ok: true, message: `Edited ${p}` };
    }
    case 'list_dir': {
      const entries = await fsp.readdir(resolveSafe(args.path || '.'), { withFileTypes: true });
      return { ok: true, entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
    }
    case 'run_command': {
      try {
        const { stdout, stderr } = await execAsync(args.command, { cwd: ROOT, timeout: args.timeout_ms || 60000, maxBuffer: 10 * 1024 * 1024, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash' });
        return { ok: true, stdout, stderr };
      } catch (err) { return { ok: false, error: err.message, stdout: err.stdout, stderr: err.stderr }; }
    }
    case 'system_info': {
      const cpus = os.cpus();
      let disk = null;
      try { disk = (await execAsync(process.platform === 'win32' ? 'wmic logicaldisk get size,freespace,caption' : 'df -h .')).stdout.trim(); } catch { /* best effort */ }
      return { ok: true, platform: os.platform(), arch: os.arch(), release: os.release(), cpuModel: cpus[0]?.model, cpuCores: cpus.length, totalMemGB: (os.totalmem() / 1e9).toFixed(2), freeMemGB: (os.freemem() / 1e9).toFixed(2), uptimeHours: (os.uptime() / 3600).toFixed(2), networkInterfaces: Object.keys(os.networkInterfaces()), disk };
    }
    default: return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// =========================================================================
// Hardware tools (Arduino / serial / logic analyzer)
// =========================================================================
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const LIST_PORTS_PY = `#!/usr/bin/env python3
import json, sys
try:
    from serial.tools import list_ports
except ImportError:
    print(json.dumps({"ok": False, "error": "pyserial not installed. Run: pip install pyserial"})); sys.exit(1)
ports = [{"device": p.device, "description": p.description, "hwid": p.hwid} for p in list_ports.comports()]
print(json.dumps({"ok": True, "ports": ports}))
`;
const SERIAL_MONITOR_PY = `#!/usr/bin/env python3
import argparse, json, sys, time
try:
    import serial
except ImportError:
    print(json.dumps({"ok": False, "error": "pyserial not installed. Run: pip install pyserial"})); sys.exit(1)
ap = argparse.ArgumentParser()
ap.add_argument("--port", required=True); ap.add_argument("--baud", type=int, default=9600)
ap.add_argument("--duration", type=float, default=5.0); ap.add_argument("--max-lines", type=int, default=0)
args = ap.parse_args()
lines = []
try:
    with serial.Serial(args.port, args.baud, timeout=0.5) as ser:
        start = time.time()
        while time.time() - start < args.duration:
            if args.max_lines and len(lines) >= args.max_lines: break
            raw = ser.readline()
            if raw: lines.append(raw.decode("utf-8", errors="replace").rstrip("\\r\\n"))
    print(json.dumps({"ok": True, "port": args.port, "baud": args.baud, "lines": lines}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)})); sys.exit(1)
`;
function ensureHelperScripts() {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  const p1 = path.join(SCRIPTS_DIR, 'list_ports.py'), p2 = path.join(SCRIPTS_DIR, 'serial_monitor.py');
  if (!fs.existsSync(p1)) fs.writeFileSync(p1, LIST_PORTS_PY, 'utf-8');
  if (!fs.existsSync(p2)) fs.writeFileSync(p2, SERIAL_MONITOR_PY, 'utf-8');
}
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function safeJson(text) { try { return JSON.parse(text.trim()); } catch { return { ok: false, error: 'Could not parse tool output', raw: text }; } }
async function runShell(cmd, opts = {}) {
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd: ROOT, timeout: opts.timeout_ms || 30000, maxBuffer: 20 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (err) { return { ok: false, error: err.message, stdout: err.stdout, stderr: err.stderr }; }
}

const HARDWARE_TOOL_DEFS = [
  { type: 'function', function: { name: 'arduino_list_boards', description: 'List connected Arduino-compatible boards and their serial ports.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'arduino_compile', description: 'Compile an Arduino sketch without uploading it.', parameters: { type: 'object', properties: { sketch_path: { type: 'string' }, fqbn: { type: 'string' } }, required: ['sketch_path', 'fqbn'] } } },
  { type: 'function', function: { name: 'arduino_flash', description: 'Compile and upload an Arduino sketch to a board over serial.', parameters: { type: 'object', properties: { sketch_path: { type: 'string' }, fqbn: { type: 'string' }, port: { type: 'string' } }, required: ['sketch_path', 'fqbn', 'port'] } } },
  { type: 'function', function: { name: 'list_serial_ports', description: 'List available serial ports on the system.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'serial_monitor', description: 'Capture serial log output for a fixed duration.', parameters: { type: 'object', properties: { port: { type: 'string' }, baud: { type: 'number' }, duration_s: { type: 'number' }, max_lines: { type: 'number' }, save_to: { type: 'string' } }, required: ['port'] } } },
  { type: 'function', function: { name: 'logic_analyzer_scan', description: 'Scan for connected logic analyzer hardware via sigrok.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'logic_analyzer_capture', description: 'Capture samples from a logic analyzer via sigrok-cli.', parameters: { type: 'object', properties: { driver: { type: 'string' }, samplerate: { type: 'string' }, samples: { type: 'number' }, channels: { type: 'string' }, output_format: { type: 'string' }, out_file: { type: 'string' } }, required: ['driver', 'samplerate', 'samples', 'out_file'] } } }
];
const HARDWARE_DESTRUCTIVE_TOOLS = new Set(['arduino_flash', 'logic_analyzer_capture']);

async function runHardwareTool(name, args) {
  switch (name) {
    case 'arduino_list_boards': {
      const r = await runShell('arduino-cli board list --format json');
      if (!r.ok) return { ok: false, error: `${r.error}\n${r.stderr || ''}`.trim(), hint: 'Is arduino-cli installed?' };
      try { return { ok: true, boards: JSON.parse(r.stdout) }; } catch { return { ok: true, raw: r.stdout }; }
    }
    case 'arduino_compile': {
      const r = await runShell(`arduino-cli compile --fqbn ${shq(args.fqbn)} ${shq(resolveSafe(args.sketch_path))}`, { timeout_ms: 120000 });
      return r.ok ? { ok: true, message: 'Compiled successfully', stdout: r.stdout } : { ok: false, error: r.error, stdout: r.stdout, stderr: r.stderr };
    }
    case 'arduino_flash': {
      const sketch = resolveSafe(args.sketch_path);
      const compile = await runShell(`arduino-cli compile --fqbn ${shq(args.fqbn)} ${shq(sketch)}`, { timeout_ms: 120000 });
      if (!compile.ok) return { ok: false, stage: 'compile', error: compile.error, stdout: compile.stdout, stderr: compile.stderr };
      const upload = await runShell(`arduino-cli upload -p ${shq(args.port)} --fqbn ${shq(args.fqbn)} ${shq(sketch)}`, { timeout_ms: 60000 });
      if (!upload.ok) return { ok: false, stage: 'upload', error: upload.error, stdout: upload.stdout, stderr: upload.stderr };
      return { ok: true, message: `Flashed ${args.fqbn} on ${args.port}`, compileOutput: compile.stdout, uploadOutput: upload.stdout };
    }
    case 'list_serial_ports': {
      ensureHelperScripts();
      const r = await runShell(`python3 ${shq(path.join(SCRIPTS_DIR, 'list_ports.py'))}`);
      return r.ok ? safeJson(r.stdout) : { ok: false, error: r.error, stderr: r.stderr };
    }
    case 'serial_monitor': {
      ensureHelperScripts();
      const baud = args.baud || 9600, duration = args.duration_s || 5, maxLines = args.max_lines || 0;
      const r = await runShell(`python3 ${shq(path.join(SCRIPTS_DIR, 'serial_monitor.py'))} --port ${shq(args.port)} --baud ${baud} --duration ${duration} --max-lines ${maxLines}`, { timeout_ms: (duration + 10) * 1000 });
      if (!r.ok) return { ok: false, error: r.error, stderr: r.stderr };
      const parsed = safeJson(r.stdout);
      if (parsed.ok && args.save_to) {
        const savePath = resolveSafe(args.save_to);
        await fsp.mkdir(path.dirname(savePath), { recursive: true });
        await fsp.writeFile(savePath, (parsed.lines || []).join('\n'), 'utf-8');
        parsed.savedTo = savePath;
      }
      return parsed;
    }
    case 'logic_analyzer_scan': {
      const r = await runShell('sigrok-cli --scan');
      return r.ok ? { ok: true, devices: r.stdout } : { ok: false, error: `${r.error}\n${r.stderr || ''}`.trim(), hint: 'Is sigrok-cli installed?' };
    }
    case 'logic_analyzer_capture': {
      const outPath = resolveSafe(args.out_file);
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      let cmd = `sigrok-cli --driver ${shq(args.driver)} --config samplerate=${shq(args.samplerate)} --samples ${args.samples}`;
      if (args.channels) cmd += ` --channels ${shq(args.channels)}`;
      cmd += ` --output-format ${shq(args.output_format || 'csv')} --output-file ${shq(outPath)}`;
      const r = await runShell(cmd, { timeout_ms: 60000 });
      if (!r.ok) return { ok: false, error: `${r.error}\n${r.stderr || ''}`.trim() };
      let preview = null;
      try { preview = (await fsp.readFile(outPath, 'utf-8')).split('\n').slice(0, 20).join('\n'); } catch { /* binary */ }
      return { ok: true, message: `Captured ${args.samples} samples to ${outPath}`, preview };
    }
    default: return { ok: false, error: `Unknown hardware tool: ${name}` };
  }
}

const ALL_TOOL_DEFS = [...CORE_TOOL_DEFS, ...HARDWARE_TOOL_DEFS];
const ALL_DESTRUCTIVE = new Set([...DESTRUCTIVE_TOOLS, ...HARDWARE_DESTRUCTIVE_TOOLS]);
const HARDWARE_TOOL_NAMES = new Set(HARDWARE_TOOL_DEFS.map(t => t.function.name));
async function dispatchTool(name, args) { return HARDWARE_TOOL_NAMES.has(name) ? runHardwareTool(name, args) : runCoreTool(name, args); }

// =========================================================================
// Sessions (persistent chat memory / split chats)
// =========================================================================
function sessionsDir() { return path.join(ROOT, '.codex-agent', 'sessions'); }
function sessionFile(name) { return path.join(sessionsDir(), `${name}.json`); }
function loadSessionMsgs(name) {
  const f = sessionFile(name);
  if (!fs.existsSync(f)) return [];
  try { const d = JSON.parse(fs.readFileSync(f, 'utf-8')); return Array.isArray(d) ? d : []; } catch { return []; }
}
function saveSessionMsgs(name, msgs) {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(sessionFile(name), JSON.stringify(msgs.slice(1), null, 2), 'utf-8');
}
function listSessions() {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json')).map(f => {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    let turns = 0;
    try { turns = JSON.parse(fs.readFileSync(full, 'utf-8')).length; } catch { /* ignore */ }
    const name = f.replace(/\.json$/, '');
    const meta = getSessionMeta(name);
    return { name, updated: stat.mtime.toISOString(), turns, branchedFrom: meta?.branchedFrom || null };
  }).sort((a, b) => new Date(b.updated) - new Date(a.updated));
}
function deleteSessionFile(name) {
  const f = sessionFile(name);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  const meta = path.join(sessionsDir(), `${name}.meta.json`);
  if (fs.existsSync(meta)) fs.unlinkSync(meta);
}

// Auto-generates a free branch name like "default-branch", "default-branch-2", ...
// so branching never needs an upfront prompt — rename it later if you want something else.
function autoBranchName(fromName) {
  const base = `${fromName}-branch`;
  if (!fs.existsSync(sessionFile(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(sessionFile(candidate))) return candidate;
  }
  return `${base}-${Date.now()}`; // astronomically unlikely fallback
}

function slugify(text, maxWords = 6, maxLen = 42) {
  const words = text.trim().split(/\s+/).slice(0, maxWords).join(' ');
  let slug = words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > maxLen) slug = slug.slice(0, maxLen).replace(/-+$/, '');
  return slug;
}

function freeSessionName(base, fromName) {
  if (!base) return autoBranchName(fromName);
  if (!fs.existsSync(sessionFile(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(sessionFile(candidate))) return candidate;
  }
  return autoBranchName(fromName);
}

// Names a branch after the conversation it's actually branching from — the most
// recent user prompt at or before the branch point — instead of a generic counter.
// e.g. branching after a reply about "explain the auth flow" -> "explain-the-auth-flow".
function contextualBranchName(fromName, currentMessages, upto) {
  const limit = (typeof upto === 'number' && upto > 0) ? Math.min(upto, currentMessages.length) : currentMessages.length;
  for (let i = limit - 1; i >= 0; i--) {
    const m = currentMessages[i];
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      const slug = slugify(m.content);
      if (slug) return freeSessionName(slug, fromName);
      break;
    }
  }
  return autoBranchName(fromName);
}

function renameSession(oldName, newName) {
  if (!newName || !newName.trim()) return { ok: false, error: 'Name required' };
  newName = newName.trim();
  if (oldName === newName) return { ok: true, unchanged: true };
  if (!fs.existsSync(sessionFile(oldName))) return { ok: false, error: `"${oldName}" doesn't exist` };
  if (fs.existsSync(sessionFile(newName))) return { ok: false, error: `A chat named "${newName}" already exists` };
  fs.renameSync(sessionFile(oldName), sessionFile(newName));
  const oldMeta = path.join(sessionsDir(), `${oldName}.meta.json`);
  const newMeta = path.join(sessionsDir(), `${newName}.meta.json`);
  if (fs.existsSync(oldMeta)) fs.renameSync(oldMeta, newMeta);
  return { ok: true };
}

function branchSession(newName, fromName, currentMessages, upto) {
  if (!newName || !newName.trim()) return { ok: false, error: 'Name required' };
  if (fs.existsSync(sessionFile(newName))) return { ok: false, error: `A chat named "${newName}" already exists` };
  // fork = save the conversation up to a given point under the new name,
  // tagged with which chat it branched from (for display only, doesn't affect loading)
  const slice = (typeof upto === 'number' && upto > 0) ? currentMessages.slice(0, upto) : currentMessages;
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(sessionFile(newName), JSON.stringify(slice.slice(1), null, 2), 'utf-8');
  const metaPath = path.join(sessionsDir(), `${newName}.meta.json`);
  fs.writeFileSync(metaPath, JSON.stringify({ branchedFrom: fromName, branchedAt: new Date().toISOString() }, null, 2), 'utf-8');
  return { ok: true };
}
// Given the index of a message, returns the next index that's safe to cut a
// conversation at — skips past any tool_call results immediately following,
// so a branch never lands mid-tool-call (which would leave a dangling,
// unanswered tool_call and break the branched chat's first request).
function safeCheckpointAfter(idx) {
  let j = idx + 1;
  while (j < messages.length) {
    const m = messages[j];
    const isToolResult = m.role === 'tool' || (m.role === 'user' && Array.isArray(m.content) && m.content.length > 0 && m.content.every(b => b.type === 'tool_result'));
    if (!isToolResult) break;
    j++;
  }
  return j;
}
function getSessionMeta(name) {
  const f = path.join(sessionsDir(), `${name}.meta.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; }
}

async function gitClone(url, dest) {
  const target = dest ? resolveSafe(dest) : resolveSafe(path.basename(url.replace(/\.git$/, '')));
  const r = await runShell(`git clone ${shq(url)} ${shq(target)}`, { timeout_ms: 120000 });
  return r.ok ? { ok: true, path: target, stdout: r.stdout, stderr: r.stderr } : { ok: false, error: r.error, stderr: r.stderr };
}
function listGitProjects() {
  if (!fs.existsSync(ROOT)) return [];
  return fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory()).filter(e => fs.existsSync(path.join(ROOT, e.name, '.git'))).map(e => e.name);
}

// =========================================================================
// Bookmarked projects — a persistent list of arbitrary folders (git repos
// or not), stored next to server.js so it survives cd's and restarts, and
// isn't scoped to whatever ROOT happens to be right now.
// =========================================================================
const BOOKMARKS_FILE = path.join(__dirname, 'projects.json');

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadBookmarks() {
  if (!fs.existsSync(BOOKMARKS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function saveBookmarks(list) {
  fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(list, null, 2), 'utf-8');
}
function addBookmark(rawPath, name) {
  const resolved = path.resolve(expandHome(rawPath));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, error: `Not a directory: ${resolved}` };
  }
  const list = loadBookmarks();
  const existing = list.find(b => b.path === resolved);
  const isGit = fs.existsSync(path.join(resolved, '.git'));
  if (existing) {
    existing.name = name || existing.name;
    existing.isGit = isGit;
  } else {
    list.push({ name: name || path.basename(resolved), path: resolved, isGit });
  }
  saveBookmarks(list);
  return { ok: true, bookmarks: list };
}
function removeBookmark(rawPath) {
  const resolved = path.resolve(expandHome(rawPath));
  const list = loadBookmarks().filter(b => b.path !== resolved);
  saveBookmarks(list);
  return list;
}

function buildSystemPrompt() {
  return `You are a local coding/ops agent running with real file, shell, and hardware (Arduino/serial/logic-analyzer) access via tools.
Working directory: ${ROOT}
Rules:
- Use tools to read/inspect before you write or flash; don't guess file contents or board/port names.
- Prefer small, verifiable steps.
- Explain briefly what you're about to do before calling a destructive tool.
- Never invent output — only report what tools actually returned.
- If a task is ambiguous, ask a short clarifying question instead of guessing.
- This is a git-aware environment: use run_command for any git operation and for installing dependencies / running builds and tests.`;
}

let sessionName = 'default';
let messages = [{ role: 'system', content: buildSystemPrompt() }, ...loadSessionMsgs(sessionName)];

// =========================================================================
// SSE broadcast + pending approvals
// =========================================================================
const sseClients = new Set();
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch { /* client gone */ } }
}
const pendingApprovals = new Map();
async function confirm(toolName, toolArgs) {
  if (approvalMode === 'full') return true;
  if (approvalMode === 'readonly') return false; // belt-and-suspenders — readonly mode also excludes these tools from what the model is offered, see toolDefsForRequest()
  const id = crypto.randomUUID();
  broadcast({ type: 'approval_request', id, tool: toolName, args: toolArgs });
  return new Promise(resolve => pendingApprovals.set(id, resolve));
}

// In read-only mode, don't even offer destructive tools to the model — it's
// cleaner than letting it try and get denied every time, and it can explain
// the limitation to the person directly instead of repeatedly retrying.
function toolDefsForRequest() {
  if (approvalMode === 'readonly') return ALL_TOOL_DEFS.filter(t => !ALL_DESTRUCTIVE.has(t.function.name));
  return ALL_TOOL_DEFS;
}

// =========================================================================
// Provider calls
// =========================================================================
function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

let lastUsage = null; // { promptTokens, completionTokens, totalTokens } from the most recent provider response
const modelContextLimits = {}; // populated as /api/models is fetched — model id -> context_length
// best-effort fallback for models we haven't live-fetched a list for yet (mainly Anthropic,
// which isn't an openai-chat kind provider so it never hits the live /api/models fetch)
const FALLBACK_CONTEXT_LIMITS = {
  'claude-sonnet-4-6': 200000, 'claude-opus-4-8': 200000, 'claude-haiku-4-5-20251001': 200000,
  'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4.1': 1000000, 'o3-mini': 200000,
  'llama-3.3-70b-versatile': 128000, 'llama-3.1-8b-instant': 128000, 'llama3.1': 128000
};
function contextLimitFor(m) { return modelContextLimits[m] || FALLBACK_CONTEXT_LIMITS[m] || null; }

async function callOpenAIChat(signal) {
  const key = getApiKey(provider);
  const res = await fetch(provider.baseURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(provider.extraHeaders || {}) },
    body: JSON.stringify({ model, messages, tools: toolDefsForRequest(), tool_choice: 'auto' }),
    signal
  });
  if (!res.ok) throw new Error(`${provider.label} API error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error(`Unexpected response: ${JSON.stringify(data).slice(0, 500)}`);
  if (data.usage) lastUsage = { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens };
  const toolCalls = (choice.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function.name, args: safeParse(tc.function.arguments) }));
  return { assistantText: choice.content || '', toolCalls, rawMessage: choice };
}
async function callAnthropicMessages(signal) {
  const key = getApiKey(provider);
  const system = messages.find(m => m.role === 'system')?.content || '';
  const convo = messages.filter(m => m.role !== 'system');
  const res = await fetch(provider.baseURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, system, messages: convo, tools: toolDefsForRequest().map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) }),
    signal
  });
  if (!res.ok) throw new Error(`${provider.label} API error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  if (data.usage) lastUsage = { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens, totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0) };
  const toolCalls = data.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input }));
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { assistantText: text, toolCalls, rawMessage: data };
}
async function callProvider(signal) {
  if (provider.kind === 'openai-chat') return callOpenAIChat(signal);
  if (provider.kind === 'anthropic-messages') return callAnthropicMessages(signal);
  throw new Error(`Unsupported provider kind: ${provider.kind}`);
}

let busy = false;
let currentAbortController = null;
let stopRequested = false;

async function runAgentLoop(turnStartIndex) {
  busy = true;
  stopRequested = false;
  const maxRounds = approvalMode === 'full' ? 200 : 12; // Full Access keeps going instead of stopping to ask; still capped so a genuine runaway loop can't run forever unattended
  try {
    for (let round = 0; round < maxRounds; round++) {
      if (stopRequested) { broadcast({ type: 'stopped' }); return; }
      broadcast({ type: 'thinking' });
      currentAbortController = new AbortController();
      let result;
      try { result = await callProvider(currentAbortController.signal); }
      catch (err) {
        if (err.name === 'AbortError') { broadcast({ type: 'stopped' }); return; }
        broadcast({ type: 'error', message: err.message }); return;
      } finally { currentAbortController = null; }
      broadcast({ type: 'usage', usage: lastUsage, contextLimit: contextLimitFor(model) });

      const isFinal = result.toolCalls.length === 0;
      if (result.assistantText) broadcast({ type: 'assistant_message', text: result.assistantText, final: isFinal, turnStart: turnStartIndex });
      messages.push(provider.kind === 'openai-chat' ? result.rawMessage : { role: 'assistant', content: result.rawMessage.content });

      if (isFinal) {
        if (result.assistantText) broadcast({ type: 'checkpoint', index: messages.length });
        broadcast({ type: 'done' });
        return;
      }

      for (const call of result.toolCalls) {
        if (stopRequested) { broadcast({ type: 'stopped' }); return; }
        broadcast({ type: 'tool_call', name: call.name, args: call.args });
        let approved = true;
        if (ALL_DESTRUCTIVE.has(call.name)) approved = await confirm(call.name, call.args);

        let toolResult;
        if (!approved) toolResult = { ok: false, error: approvalMode === 'readonly' ? 'Blocked — read-only mode is on. Switch modes to allow this.' : 'User denied this action.' };
        else { try { toolResult = await dispatchTool(call.name, call.args); } catch (err) { toolResult = { ok: false, error: err.message }; } }

        broadcast({ type: 'tool_result', name: call.name, result: toolResult });

        if (provider.kind === 'openai-chat') messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolResult) });
        else messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(toolResult) }] });
      }
      // stable state again now that every tool_call in this round has a matching result —
      // safe to associate with this round's assistant bubble (if it had visible text)
      if (result.assistantText) broadcast({ type: 'checkpoint', index: messages.length });
    }
    broadcast({ type: 'error', message: `Stopped after ${maxRounds} tool rounds — send another message to continue.` });
  } finally {
    saveSessionMsgs(sessionName, messages);
    busy = false;
    stopRequested = false;
    currentAbortController = null;
    broadcast({ type: 'idle', usage: lastUsage, contextLimit: contextLimitFor(model) });
  }
}

async function agentTurn(userInput) {
  messages.push({ role: 'user', content: userInput });
  const turnStartIndex = messages.length; // index right after this user message — used to identify this turn for rerun/branch/edit
  broadcast({ type: 'user_message', text: userInput, turnStart: turnStartIndex });
  await runAgentLoop(turnStartIndex);
}

function switchSession(name) {
  sessionName = name;
  messages = [{ role: 'system', content: buildSystemPrompt() }, ...loadSessionMsgs(name)];
  lastUsage = null; // stale for a different conversation — next reply will repopulate it
}

// True if this raw message included a tool call (OpenAI's tool_calls array,
// or Anthropic's tool_use content blocks) — used to identify which replies
// are a turn's *final* answer (safe to offer "rerun") vs. an interim step.
function messageHasToolCalls(m) {
  if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
  if (Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_use')) return true;
  return false;
}

// rendered chat history the frontend can render on load/refresh (skip system + raw tool plumbing noise, keep it simple: we replay via events log instead)
function historyForClient() {
  const out = [];
  let turnStart = null;
  messages.forEach((m, i) => {
    if (i === 0) return; // skip system prompt
    if (m.role === 'user' && typeof m.content === 'string') {
      turnStart = i + 1;
      out.push({ type: 'user_message', text: m.content, turnStart });
    } else if (m.role === 'assistant' && m.content) {
      out.push({
        type: 'assistant_message', text: m.content,
        checkpoint: safeCheckpointAfter(i),
        final: !messageHasToolCalls(m),
        turnStart
      });
    }
    // tool/tool_result messages intentionally skipped in replay; keeps the transcript readable
  });
  return out;
}

// =========================================================================
// HTTP server
// =========================================================================
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json', ...headers });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', c => chunks += c);
    req.on('end', () => { try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); } });
  });
}

const INDEX_HTML_CANDIDATES = [
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'index.html')
];
function findIndexHtml() {
  for (const p of INDEX_HTML_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error(`Could not find index.html — looked in:\n  ${INDEX_HTML_CANDIDATES.join('\n  ')}`);
}
const INDEX_HTML_PATH = findIndexHtml();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS-free, same-origin only — this server is local-only by design.
  if (url.pathname === '/' ) {
    return send(res, 200, fs.readFileSync(INDEX_HTML_PATH, 'utf-8'));
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    return send(res, 200, {
      provider: providerName, model, root: ROOT, sessionName, busy, mode: approvalMode,
      sessions: listSessions(), history: historyForClient(),
      providers: Object.entries(PROVIDERS).map(([name, p]) => ({ name, label: p.label, defaultModel: p.defaultModel })),
      bookmarks: loadBookmarks(),
      usage: lastUsage, contextLimit: contextLimitFor(model)
    });
  }

  if (url.pathname === '/api/mode' && req.method === 'POST') {
    const { mode } = await readBody(req);
    if (!VALID_MODES.has(mode)) return send(res, 400, { ok: false, error: `Invalid mode. Must be one of: ${[...VALID_MODES].join(', ')}` });
    approvalMode = mode;
    return send(res, 200, { ok: true, mode: approvalMode });
  }

  if (url.pathname === '/api/message' && req.method === 'POST') {
    if (busy) return send(res, 409, { ok: false, error: 'Agent is already working on a previous message.' });
    const { text } = await readBody(req);
    if (!text || !text.trim()) return send(res, 400, { ok: false, error: 'Empty message' });
    agentTurn(text.trim()); // fire and forget — progress streams over SSE
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/approve' && req.method === 'POST') {
    const { id, approved } = await readBody(req);
    const resolve = pendingApprovals.get(id);
    if (!resolve) return send(res, 404, { ok: false, error: 'Unknown or already-resolved approval id' });
    pendingApprovals.delete(id);
    resolve(!!approved);
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/session/new' && req.method === 'POST') {
    const { name } = await readBody(req);
    switchSession(name || `session-${Date.now()}`);
    return send(res, 200, { ok: true, sessionName });
  }
  if (url.pathname === '/api/session/switch' && req.method === 'POST') {
    const { name } = await readBody(req);
    if (!name) return send(res, 400, { ok: false, error: 'name required' });
    switchSession(name);
    return send(res, 200, { ok: true, sessionName, history: historyForClient() });
  }
  if (url.pathname === '/api/session/delete' && req.method === 'POST') {
    const { name } = await readBody(req);
    if (!name) return send(res, 400, { ok: false, error: 'name required' });
    deleteSessionFile(name);
    if (name === sessionName) switchSession('default');
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/session/clear' && req.method === 'POST') {
    messages = [{ role: 'system', content: buildSystemPrompt() }];
    saveSessionMsgs(sessionName, messages);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/session/branch' && req.method === 'POST') {
    if (busy) return send(res, 409, { ok: false, error: 'Wait for the current reply to finish before branching.' });
    const { name, upto } = await readBody(req);
    const branchName = (name && name.trim()) ? name.trim() : contextualBranchName(sessionName, messages, upto);
    const result = branchSession(branchName, sessionName, messages, upto);
    if (!result.ok) return send(res, 400, result);
    switchSession(branchName);
    return send(res, 200, { ok: true, sessionName, history: historyForClient() });
  }
  if (url.pathname === '/api/session/rename' && req.method === 'POST') {
    const { oldName, newName } = await readBody(req);
    if (!oldName) return send(res, 400, { ok: false, error: 'oldName required' });
    const result = renameSession(oldName, newName);
    if (!result.ok) return send(res, 400, result);
    if (oldName === sessionName) sessionName = newName.trim();
    return send(res, 200, { ok: true, sessionName });
  }

  if (url.pathname === '/api/session/rerun' && req.method === 'POST') {
    if (busy) return send(res, 409, { ok: false, error: 'Wait for the current reply to finish first.' });
    const { turnStart } = await readBody(req);
    if (typeof turnStart !== 'number' || turnStart < 1 || turnStart > messages.length) {
      return send(res, 400, { ok: false, error: 'Invalid rerun target' });
    }
    const triggeringMsg = messages[turnStart - 1];
    if (!triggeringMsg || triggeringMsg.role !== 'user' || typeof triggeringMsg.content !== 'string') {
      return send(res, 400, { ok: false, error: "Couldn't find that prompt to rerun" });
    }
    messages = messages.slice(0, turnStart); // drop everything after the triggering prompt — its old answer and any tool activity
    saveSessionMsgs(sessionName, messages);
    runAgentLoop(turnStart); // fire-and-forget — new answer streams over SSE like a normal turn
    return send(res, 200, { ok: true, history: historyForClient() });
  }

  if (url.pathname === '/api/session/edit' && req.method === 'POST') {
    if (busy) return send(res, 409, { ok: false, error: 'Wait for the current reply to finish first.' });
    const { turnStart, newText } = await readBody(req);
    if (typeof turnStart !== 'number' || turnStart < 1 || turnStart > messages.length) {
      return send(res, 400, { ok: false, error: 'Invalid edit target' });
    }
    if (!newText || !newText.trim()) return send(res, 400, { ok: false, error: 'New text required' });
    const triggeringMsg = messages[turnStart - 1];
    if (!triggeringMsg || triggeringMsg.role !== 'user' || typeof triggeringMsg.content !== 'string') {
      return send(res, 400, { ok: false, error: "Couldn't find that prompt to edit" });
    }
    messages = messages.slice(0, turnStart - 1); // drop the old prompt AND everything after it
    messages.push({ role: 'user', content: newText.trim() });
    const newTurnStart = messages.length;
    saveSessionMsgs(sessionName, messages);
    runAgentLoop(newTurnStart); // fire-and-forget — new answer streams over SSE like a normal turn
    return send(res, 200, { ok: true, history: historyForClient() });
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    if (!busy) return send(res, 200, { ok: true, message: 'Nothing running.' });
    stopRequested = true;
    if (currentAbortController) currentAbortController.abort();
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/cd' && req.method === 'POST') {
    const { dir } = await readBody(req);
    const resolved = path.resolve(ROOT, dir || '.');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return send(res, 400, { ok: false, error: 'Not a directory' });
    ROOT = resolved;
    process.chdir(ROOT);
    switchSession('default');
    return send(res, 200, { ok: true, root: ROOT, sessionName, history: historyForClient() });
  }
  if (url.pathname === '/api/projects' && req.method === 'GET') {
    return send(res, 200, { ok: true, projects: listGitProjects(), root: ROOT });
  }
  if (url.pathname === '/api/clone' && req.method === 'POST') {
    const { url: gitUrl, dest } = await readBody(req);
    if (!gitUrl) return send(res, 400, { ok: false, error: 'url required' });
    const result = await gitClone(gitUrl, dest);
    return send(res, result.ok ? 200 : 500, result);
  }

  if (url.pathname === '/api/bookmarks' && req.method === 'GET') {
    return send(res, 200, { ok: true, bookmarks: loadBookmarks() });
  }
  if (url.pathname === '/api/bookmarks/add' && req.method === 'POST') {
    const { path: rawPath, name } = await readBody(req);
    if (!rawPath) return send(res, 400, { ok: false, error: 'path required' });
    const result = addBookmark(rawPath, name);
    return send(res, result.ok ? 200 : 400, result);
  }
  if (url.pathname === '/api/bookmarks/remove' && req.method === 'POST') {
    const { path: rawPath } = await readBody(req);
    if (!rawPath) return send(res, 400, { ok: false, error: 'path required' });
    const bookmarks = removeBookmark(rawPath);
    return send(res, 200, { ok: true, bookmarks });
  }

  if (url.pathname === '/api/browse' && req.method === 'GET') {
    let target = url.searchParams.get('dir') || os.homedir();
    target = path.resolve(expandHome(target));
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return send(res, 400, { ok: false, error: `Not a directory: ${target}` });
    }
    let entries;
    try {
      entries = fs.readdirSync(target, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (err) {
      return send(res, 200, { ok: false, error: `Can't read this folder: ${err.message}`, path: target, parent: path.dirname(target), entries: [] });
    }
    const parent = path.dirname(target);
    return send(res, 200, { ok: true, path: target, parent: parent === target ? null : parent, entries, isGit: fs.existsSync(path.join(target, '.git')) });
  }

  if (url.pathname === '/api/models' && req.method === 'GET') {
    const target = url.searchParams.get('provider') || providerName;
    let p;
    try { p = getProvider(target); } catch (err) { return send(res, 400, { ok: false, error: err.message }); }
    if (p.kind !== 'openai-chat') return send(res, 200, { ok: false, error: 'Live model listing is only available for OpenAI-compatible providers (OpenRouter, OpenAI, Groq, local servers).' });
    try {
      const modelsURL = p.baseURL.replace(/\/chat\/completions\/?$/, '/models');
      const key = getApiKey(p);
      const r = await fetch(modelsURL, { headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(p.extraHeaders || {}) } });
      if (!r.ok) return send(res, 200, { ok: false, error: `${p.label} returned HTTP ${r.status} for the model list.` });
      const data = await r.json();
      const models = (data.data || []).map(m => m.id).filter(Boolean).sort();
      for (const m of (data.data || [])) {
        if (m.id && (m.context_length || m.context_window)) modelContextLimits[m.id] = m.context_length || m.context_window;
      }
      return send(res, 200, { ok: true, models });
    } catch (err) {
      return send(res, 200, { ok: false, error: `Could not reach ${p.label}: ${err.message}` });
    }
  }

  if (url.pathname === '/api/provider' && req.method === 'POST') {
    const { name, model: newModel } = await readBody(req);
    try {
      provider = getProvider(name);
      providerName = name;
      model = newModel || provider.defaultModel;
      lastUsage = null; // stale for a different model's context window
      return send(res, 200, { ok: true, providerName, model });
    } catch (err) { return send(res, 400, { ok: false, error: err.message }); }
  }

  send(res, 404, { ok: false, error: 'Not found' });
});

function findOpenPort(start, cb) {
  const tryPort = (p) => {
    const s = http.createServer();
    s.once('error', () => { s.close(() => tryPort(p + 1)); });
    s.once('listening', () => { s.close(() => cb(p)); });
    s.listen(p, '127.0.0.1');
  };
  tryPort(start);
}

ensureHelperScripts();
findOpenPort(4174, (port) => {
  server.listen(port, '127.0.0.1', () => {
    console.log(`codex-agent GUI server running at http://localhost:${port}`);
    console.log(`Working directory: ${ROOT}`);
    // Let the launcher script handle opening the browser window; also print
    // the URL in case it needs to be opened manually.
    fs.writeFileSync(path.join(__dirname, '.port'), String(port), 'utf-8');
  });
});
