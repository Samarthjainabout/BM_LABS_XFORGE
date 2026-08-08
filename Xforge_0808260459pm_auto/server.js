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

// Same deal as the OpenRouter key above — shared in plain text, so treat it as
// exposed and rotate it at artificialanalysis.ai when convenient. Powers the
// live model rankings for Auto mode; everything falls back to static lists
// fine without it.
const BAKED_IN_AA_API_KEY = 'aa_iSgiKcQLjeghuFaoxpkifTDVPubMzoVr';
if (!process.env.AA_API_KEY) process.env.AA_API_KEY = BAKED_IN_AA_API_KEY;

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
function scriptsDir() { return path.join(ROOT, 'scripts'); } // function, not a frozen const — ROOT can change (restored state, /cd, bookmarks) after module load
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
  fs.mkdirSync(scriptsDir(), { recursive: true });
  const p1 = path.join(scriptsDir(), 'list_ports.py'), p2 = path.join(scriptsDir(), 'serial_monitor.py');
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
      const r = await runShell(`python3 ${shq(path.join(scriptsDir(), 'list_ports.py'))}`);
      return r.ok ? safeJson(r.stdout) : { ok: false, error: r.error, stderr: r.stderr };
    }
    case 'serial_monitor': {
      ensureHelperScripts();
      const baud = args.baud || 9600, duration = args.duration_s || 5, maxLines = args.max_lines || 0;
      const r = await runShell(`python3 ${shq(path.join(scriptsDir(), 'serial_monitor.py'))} --port ${shq(args.port)} --baud ${baud} --duration ${duration} --max-lines ${maxLines}`, { timeout_ms: (duration + 10) * 1000 });
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
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (!Array.isArray(d)) return [];
    // clean up any thinking blocks saved before this fix existed — old poisoned
    // sessions would otherwise keep hitting the same signature error forever,
    // even after upgrading, since the bad content is sitting in the file itself
    return d.map(m => (m && m.role === 'assistant') ? stripThinkingBlocks(m) : m);
  } catch { return []; }
}
function saveSessionMsgs(name, msgs) {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(sessionFile(name), JSON.stringify(msgs.slice(1), null, 2), 'utf-8');
}
function listSessions(includeArchived = false) {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json')).map(f => {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    let turns = 0;
    try { turns = JSON.parse(fs.readFileSync(full, 'utf-8')).length; } catch { /* ignore */ }
    const name = f.replace(/\.json$/, '');
    const meta = getSessionMeta(name);
    return { name, updated: stat.mtime.toISOString(), turns, branchedFrom: meta?.branchedFrom || null, archived: !!meta?.archived };
  })
    .filter(s => includeArchived || !s.archived)
    .sort((a, b) => new Date(b.updated) - new Date(a.updated));
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
function setSessionMeta(name, patch) {
  const f = path.join(sessionsDir(), `${name}.meta.json`);
  const existing = getSessionMeta(name) || {};
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...existing, ...patch }, null, 2), 'utf-8');
}
function archiveSession(name) {
  if (!fs.existsSync(sessionFile(name))) return { ok: false, error: `"${name}" doesn't exist` };
  setSessionMeta(name, { archived: true, archivedAt: new Date().toISOString() });
  return { ok: true };
}
function unarchiveSession(name) {
  if (!fs.existsSync(sessionFile(name))) return { ok: false, error: `"${name}" doesn't exist` };
  setSessionMeta(name, { archived: false, archivedAt: null });
  return { ok: true };
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
const LAST_STATE_FILE = path.join(__dirname, 'last-state.json');

// Remembers which project folder + chat was active, so relaunching
// start.command picks up exactly where you left off instead of always
// resetting to the app's own install folder. Saved on every /cd and every
// session switch; restored once at startup, before the server starts
// listening. Silently does nothing if the saved folder no longer exists —
// falls back to the normal launch-folder behavior in that case.
function saveLastState() {
  try { fs.writeFileSync(LAST_STATE_FILE, JSON.stringify({ root: ROOT, sessionName }, null, 2), 'utf-8'); }
  catch { /* best effort — not worth failing a request over */ }
}
function restoreLastState() {
  if (!fs.existsSync(LAST_STATE_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(LAST_STATE_FILE, 'utf-8'));
    if (saved.root && fs.existsSync(saved.root) && fs.statSync(saved.root).isDirectory()) {
      ROOT = saved.root;
      process.chdir(ROOT);
      switchSession(loadPerProjectLastSession());
    }
  } catch { /* corrupt or unreadable — just start fresh in the launch folder */ }
}

// Separate from the app-wide "which project was I in" tracking above, this
// remembers which specific chat (including branches) was last active
// *within* a given project — stored inside that project's own
// .codex-agent folder, so the memory travels with the project itself
// (e.g. survives a copy/move of the folder) rather than living only in the
// app's install directory. Without this, navigating back into a project
// you'd branched a few chats deep in would always dump you back on
// "default" instead of the branch you were actually working on.
function perProjectLastSessionFile() { return path.join(ROOT, '.codex-agent', 'last-session.txt'); }
function savePerProjectLastSession() {
  try {
    fs.mkdirSync(path.join(ROOT, '.codex-agent'), { recursive: true });
    fs.writeFileSync(perProjectLastSessionFile(), sessionName, 'utf-8');
  } catch { /* best effort */ }
}
function loadPerProjectLastSession() {
  try {
    const f = perProjectLastSessionFile();
    if (fs.existsSync(f)) {
      const name = fs.readFileSync(f, 'utf-8').trim();
      if (name && fs.existsSync(sessionFile(name))) return name; // only honor it if that chat still actually exists (wasn't deleted since)
    }
  } catch { /* ignore */ }
  return 'default';
}

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
- This is a git-aware environment: use run_command for any git operation and for installing dependencies / running builds and tests.

Narration (how you report progress to the user):
- Before each tool call or group of related tool calls, emit one short plain-English line saying WHAT you're doing and WHY, in that order. Aim for under 20 words; one sentence, no bullet points.
- Write it for someone watching who has not read the command. Say the intent, not the syntax: "Checking which serial port the measurement Teensy is on" — not "Running ps aux | grep -E sync_con over ssh".
- Do not paste commands, file paths, IP addresses, flags, or code into the narration line. The command itself is already shown next to it.
- When a tool call fails, the next narration line must say what failed in plain terms and what you're trying instead: "That path didn't exist, so I'm searching the repo for the sketch by name."
- When you repeat a similar step several times, say what's different about this one ("same check, now on the second board") rather than repeating the same line.
- At the end of a turn, before the final answer, state in one or two sentences what changed on disk or on hardware as a result — or say explicitly that nothing was changed.`;
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

// Strips 'thinking'/'redacted_thinking' content blocks (and any reasoning
// passthrough fields) from an assistant message before it's stored in
// history. These carry a cryptographic signature tied to the exact model
// and backend route that produced them — replaying one back in a later
// request is fine if the same model/route handles it again, but breaks
// with "Invalid signature in thinking block" the moment a different model
// or backend answers instead. That's routine with Auto mode, which
// deliberately switches models mid-conversation, so this always runs
// regardless of mode. Only the actual text/tool_calls matter for context —
// the model doesn't need to see its own past internal reasoning verbatim
// to keep going.
function stripThinkingBlocks(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'object') return rawMessage;
  const clean = { ...rawMessage };
  if (Array.isArray(clean.content)) {
    clean.content = clean.content.filter(b => b && b.type !== 'thinking' && b.type !== 'redacted_thinking');
  }
  delete clean.reasoning_details;
  delete clean.reasoning;
  return clean;
}

let lastUsage = null; // { promptTokens, completionTokens, totalTokens } from the most recent provider response
const modelContextLimits = {}; // populated as /api/models is fetched — model id -> context_length
const modelPricing = {}; // populated as /api/models is fetched — model id -> { promptPerM, completionPerM } USD per 1M tokens
// best-effort fallback for models we haven't live-fetched a list for yet (mainly Anthropic,
// which isn't an openai-chat kind provider so it never hits the live /api/models fetch)
const FALLBACK_CONTEXT_LIMITS = {
  'claude-sonnet-4-6': 200000, 'claude-opus-4-8': 200000, 'claude-haiku-4-5-20251001': 200000,
  'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4.1': 1000000, 'o3-mini': 200000,
  'llama-3.3-70b-versatile': 128000, 'llama-3.1-8b-instant': 128000, 'llama3.1': 128000
};
function contextLimitFor(m) { return modelContextLimits[m] || FALLBACK_CONTEXT_LIMITS[m] || null; }

// -------------------------------------------------------------------------
// Account quota (money) — completely separate from context window (tokens).
// The two get confused constantly: a conversation can be nowhere near filling
// the model's context while the key is already out of credit, which is exactly
// what a 403 "key limit exceeded" is telling you.
// -------------------------------------------------------------------------
let keyQuota = null;      // { limit, remaining, usage, reset, label } in USD, or null if unknown
let keyQuotaFetchedAt = 0;

async function fetchKeyQuota() {
  if (providerName !== 'openrouter') { keyQuota = null; return null; }
  if (Date.now() - keyQuotaFetchedAt < 30_000) return keyQuota; // cache — this is a billing endpoint, don't hammer it
  keyQuotaFetchedAt = Date.now();
  const key = getApiKey(provider);
  if (!key) { keyQuota = null; return null; }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) { keyQuota = null; return null; }
    const { data } = await res.json();
    keyQuota = {
      limit: data?.limit ?? null,                  // null means the key has no cap
      remaining: data?.limit_remaining ?? null,
      usage: data?.usage ?? null,                  // dollars spent on this key
      reset: data?.limit_reset ?? null,            // 'daily' | 'weekly' | 'monthly' | null
      label: data?.label || ''
    };
    return keyQuota;
  } catch { keyQuota = null; return null; }
}

// Translates known upstream error shapes into something actionable instead of raw JSON.
// Same window math as the UI: OpenRouter resets at midnight UTC, weeks Mon–Sun.
function nextResetDate(resetType) {
  if (!resetType) return null;
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  switch (String(resetType).toLowerCase()) {
    case 'daily': d.setUTCDate(d.getUTCDate() + 1); return d;
    case 'weekly': {
      const dow = d.getUTCDay();
      const daysUntilMonday = (8 - (dow === 0 ? 7 : dow)) % 7 || 7;
      d.setUTCDate(d.getUTCDate() + daysUntilMonday);
      return d;
    }
    case 'monthly': return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    default: return null;
  }
}

// Only says something if we actually know the window — never guesses a date.
function resetSentence() {
  const reset = keyQuota && nextResetDate(keyQuota.reset);
  if (!reset) return '';
  const local = reset.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const hours = Math.max(0, Math.round((reset - Date.now()) / 3_600_000));
  return ` This ${keyQuota.reset} limit resets ${local} — about ${hours} hour${hours === 1 ? '' : 's'} from now.`;
}

function friendlyProviderError(label, status, rawText) {
  let parsed = null;
  try { parsed = JSON.parse(rawText); } catch { /* not JSON, fall through */ }
  const msg = parsed?.error?.message || '';
  if (status === 403 && /key limit|credit limit|limit exceeded/i.test(msg)) {
    return `${label} rejected this request — your API key hit its spending limit, not a context limit. ` +
      `The token counter in the top bar tracks how much of the model's context window this conversation ` +
      `fills; it has nothing to do with your account balance, which is why it can show plenty "left" while ` +
      `this fails.${resetSentence()} Raise or reset the key's cap in your OpenRouter key settings, or add credits, ` +
      `if you don't want to wait.`;
  }
  if (status === 402) {
    return `${label} rejected this request — the account is out of credits. This is a billing limit, not a ` +
      `context limit, so the token counter in the top bar is unrelated. Add credits to continue.`;
  }
  if (status === 403 && /content filter/i.test(msg)) {
    return `${label} blocked this request — its content filter flagged something in the conversation ` +
      `(often a tool result: a file's contents or a command's output) and safely redacting it would have ` +
      `broken the tool-call structure, so the whole request was rejected. Try: sending the message again ` +
      `(filters are sometimes inconsistent), switching to a different model, or narrowing whatever command/file ` +
      `produced the last tool result if it returned a lot of output.`;
  }
  if (status === 400 && /invalid `?signature`? in `?thinking`? block/i.test(rawText)) {
    const providerName = parsed?.error?.metadata?.provider_name;
    return `${label} rejected this request — a Claude "extended thinking" block's signature got corrupted in transit` +
      (providerName ? ` (routed via ${providerName})` : '') + `. This is a known relay bug on OpenRouter's side when ` +
      `Claude is served through AWS Bedrock, not something wrong with your conversation. Try: sending the message ` +
      `again (often route-dependent — a retry can land on a different backend), switching to a non-reasoning Claude ` +
      `model or a different vendor for this message, or switching provider to Anthropic directly if you have an ` +
      `ANTHROPIC_API_KEY set, which bypasses this relay entirely.`;
  }
  return `${label} API error ${status}: ${rawText.slice(0, 500)}`;
}

// ---------- Auto model routing ----------
// "Auto" mode picks the model per-round instead of one fixed model for the
// whole conversation: starts cheap, escalates to a stronger model only when
// the task actually seems to need it. Only meaningful on OpenRouter, since
// that's what gives access to this whole spread of models under one key
// with live pricing. Several named profiles, each tuned for a different kind
// of work — pick one, or edit/add profiles below to fit your own workflow.
let autoModeEnabled = false;
let autoProfileName = 'hardware';

const AUTO_PROFILES = {
  hardware: {
    label: 'Hardware Debug',
    fast: ['google/gemini-2.0-flash-001', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku'],
    capable: ['anthropic/claude-sonnet-4.6', 'openai/gpt-4.1'],
    // sounds like real electrical/signal diagnosis, not a routine action
    keywords: /\b(why|debug\w*|diagnos\w*|root ?cause|troubleshoot\w*|intermitten\w*|investigat\w*|not working|isn'?t working|doesn'?t work|failing|glitch\w*|unstable|inconsistent|compare.*(expected|against)|explain (the|why)|voltage|signal integrity|noise|ground loop|short circuit|open circuit)/i
  },
  embedded: {
    label: 'Embedded / Firmware',
    fast: ['google/gemini-2.0-flash-001', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku'],
    capable: ['anthropic/claude-sonnet-4.6', 'openai/gpt-4.1', 'openai/o3-mini'],
    // interrupts, memory, RTOS, peripheral-register-level stuff — usually needs to hold a lot of state in mind
    keywords: /\b(why|debug\w*|diagnos\w*|troubleshoot\w*|interrupt\w*|watchdog|\bdma\b|\bisr\b|bootloader|rtos|freertos|zephyr|stack overflow|heap corrupt\w*|memory corrupt\w*|race condition|peripheral register|bit-?bang\w*|uart framing|i2c nack|spi timing|bus fault|hard ?fault|brown-?out|clock config\w*|register map|undefined behavior|memory leak)/i
  },
  fpga: {
    label: 'FPGA / Verilog',
    fast: ['google/gemini-2.0-flash-001', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku'],
    // RTL/timing reasoning benefits from a reasoning-tuned model, prioritized here over plain Sonnet
    capable: ['openai/o3-mini', 'anthropic/claude-sonnet-4.6', 'openai/gpt-4.1'],
    keywords: /\b(why|debug\w*|diagnos\w*|troubleshoot\w*|timing violation|setup time violation|hold time violation|clock domain cross\w*|\bcdc\b|simulation mismatch|metastab\w*|latch inferred|combinational loop|unreachable state|stuck (in|at)|race condition|negative slack|glitch\w*|unstable|inconsistent)/i
  },
  coding: {
    label: 'General Coding',
    fast: ['google/gemini-2.0-flash-001', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku'],
    capable: ['anthropic/claude-sonnet-4.6', 'openai/gpt-4.1'],
    keywords: /\b(why|debug\w*|diagnos\w*|troubleshoot\w*|bug\b|exception|stack trace|traceback|segfault|null pointer|refactor\w*|optimi[sz]e|memory leak|race condition|test\w* fail\w*|compile error|type error|undefined behavior|edge case|regression|flaky)/i
  }
};

// ---------- ArtificialAnalysis live rankings ----------
// If AA_API_KEY is set (free key from artificialanalysis.ai/data-api), auto
// mode ranks models by their live coding/agentic/intelligence index and
// price instead of the static fast/capable lists above — and re-fetches
// periodically so the ranking tracks new model releases and re-scoring
// without needing a restart. Falls back to the static lists per profile
// (defined above) whenever no key is set, the fetch fails, or a match to an
// actual OpenRouter model id can't be found for any of the top candidates.
const AA_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let aaCache = { data: [], fetchedAt: null, error: null };
let openRouterModelIdsCache = []; // plain OpenRouter model id strings, e.g. "anthropic/claude-sonnet-4.6"

const AA_CATEGORY_BY_PROFILE = {
  hardware: 'artificial_analysis_agentic_index', // debugging is a tool-call-heavy agentic loop
  embedded: 'artificial_analysis_agentic_index',
  fpga: 'artificial_analysis_coding_index',      // HDL/timing reasoning leans closer to pure code quality
  coding: 'artificial_analysis_coding_index'
};

async function fetchOpenRouterModelIds() {
  try {
    const p = getProvider('openrouter');
    const key = getApiKey(p);
    const r = await fetch(p.baseURL.replace(/\/chat\/completions\/?$/, '/models'), {
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(p.extraHeaders || {}) }
    });
    if (!r.ok) return;
    const data = await r.json();
    openRouterModelIdsCache = (data.data || []).map(m => m.id).filter(Boolean);
  } catch (err) { console.error(`⚠ Could not fetch OpenRouter model list for auto-routing: ${err.message}`); }
}

async function fetchAAData() {
  if (!process.env.AA_API_KEY) return;
  try {
    let all = [];
    for (let page = 1; page <= 3; page++) {
      const r = await fetch(`https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`, {
        headers: { 'x-api-key': process.env.AA_API_KEY }
      });
      if (!r.ok) { aaCache.error = `ArtificialAnalysis API returned HTTP ${r.status}`; return; }
      const j = await r.json();
      all = all.concat(j.data || []);
      if (!j.pagination?.has_more) break;
    }
    aaCache = { data: all, fetchedAt: new Date().toISOString(), error: null };
  } catch (err) { aaCache.error = err.message; }
}

async function refreshAutoModeData() {
  await Promise.all([fetchOpenRouterModelIds(), fetchAAData()]);
}

function normalizeForMatch(s) { return s.toLowerCase().replace(/[^a-z0-9.\-]/g, ''); }

// Best-effort match from an ArtificialAnalysis model entry to a real OpenRouter
// model id. AA's free tier doesn't expose the OpenRouter id directly, so this
// compares AA's slug against every OpenRouter id's vendor-stripped suffix:
// exact match first (always preferred — prevents e.g. "gpt-4o" incorrectly
// matching "gpt-4o-mini"), then a boundary-respecting prefix match as a
// fallback (handles version-format differences like "claude-sonnet-4" vs
// "claude-sonnet-4.6"), using the model's creator name as a tiebreaker
// whenever more than one candidate remains at either stage.
function findOpenRouterMatch(aaModel, orIds) {
  const slug = normalizeForMatch(aaModel.slug || '');
  if (!slug) return null;
  const creator = (aaModel.model_creator?.name || '').toLowerCase();
  const candidates = orIds.map(id => {
    const slashIdx = id.indexOf('/');
    const vendor = slashIdx === -1 ? '' : id.slice(0, slashIdx).toLowerCase();
    const suffix = normalizeForMatch(slashIdx === -1 ? id : id.slice(slashIdx + 1));
    return { id, vendor, suffix };
  });

  const pickBest = (list) => {
    if (list.length === 1) return list[0].id;
    const vendorMatch = list.find(c => c.vendor && (creator.includes(c.vendor) || c.vendor.includes(creator)));
    return (vendorMatch || list[0]).id;
  };

  const exact = candidates.filter(c => c.suffix === slug);
  if (exact.length) return pickBest(exact);

  const prefixed = candidates
    .filter(c => c.suffix.length > slug.length && c.suffix.startsWith(slug) && (c.suffix[slug.length] === '-' || c.suffix[slug.length] === '.'))
    .sort((a, b) => a.suffix.length - b.suffix.length); // shortest extension = closest match
  if (prefixed.length) return pickBest(prefixed);

  return null;
}

// Ranks AA's cached models for a profile/tier and returns the first one that
// resolves to a real OpenRouter id. 'fast' ranks by score-per-dollar (best
// value); 'capable' ranks by raw score alone (best quality, cost be damned —
// that's the point of escalating). Returns null if AA data isn't usable yet,
// letting the caller fall back to the static list.
function pickTierModelFromAA(profileName, tier) {
  if (!aaCache.data.length || !openRouterModelIdsCache.length) return null;
  const category = AA_CATEGORY_BY_PROFILE[profileName] || 'artificial_analysis_intelligence_index';
  const scored = aaCache.data
    .filter(m => typeof m.evaluations?.[category] === 'number')
    .map(m => {
      const inputP = m.pricing?.price_1m_input_tokens;
      const outputP = m.pricing?.price_1m_output_tokens;
      const blendedPrice = (typeof inputP === 'number' && typeof outputP === 'number') ? (inputP * 0.75 + outputP * 0.25) : null;
      return { model: m, score: m.evaluations[category], blendedPrice };
    });

  let ranked;
  if (tier === 'fast') {
    ranked = scored.filter(s => s.blendedPrice != null && s.blendedPrice > 0)
      .map(s => ({ ...s, value: s.score / s.blendedPrice }))
      .sort((a, b) => b.value - a.value);
  } else {
    ranked = scored.slice().sort((a, b) => b.score - a.score);
  }

  for (const s of ranked) {
    const orId = findOpenRouterMatch(s.model, openRouterModelIdsCache);
    if (orId) return orId;
  }
  return null;
}

function pickTierModel(tier, profileName) {
  const fromAA = pickTierModelFromAA(profileName, tier);
  if (fromAA) return fromAA;
  const profile = AUTO_PROFILES[profileName] || AUTO_PROFILES.hardware;
  const list = profile[tier] || profile.fast;
  return list[0];
}

// Decides which model to use for one round of one turn. `promptText` is the
// user's original message for this turn; `round` is 0-indexed within the
// turn; `recentFailures` counts !ok tool results so far this turn.
function chooseAutoModel({ promptText, round, recentFailures, profileName }) {
  if (round >= 2 || recentFailures >= 2) return pickTierModel('capable', profileName); // struggling — give it a stronger model to actually finish
  const profile = AUTO_PROFILES[profileName] || AUTO_PROFILES.hardware;
  if (promptText && profile.keywords.test(promptText)) return pickTierModel('capable', profileName); // sounds like real diagnosis, not routine action
  return pickTierModel('fast', profileName);
}

async function callOpenAIChat(effModel, signal) {
  const key = getApiKey(provider);
  const res = await fetch(provider.baseURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(provider.extraHeaders || {}) },
    body: JSON.stringify({ model: effModel, messages, tools: toolDefsForRequest(), tool_choice: 'auto' }),
    signal
  });
  if (!res.ok) throw new Error(friendlyProviderError(provider.label, res.status, await res.text()));
  const data = await res.json();
  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error(`Unexpected response: ${JSON.stringify(data).slice(0, 500)}`);
  if (data.usage) lastUsage = { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens };
  const toolCalls = (choice.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function.name, args: safeParse(tc.function.arguments) }));
  return { assistantText: choice.content || '', toolCalls, rawMessage: choice };
}
async function callAnthropicMessages(effModel, signal) {
  const key = getApiKey(provider);
  const system = messages.find(m => m.role === 'system')?.content || '';
  const convo = messages.filter(m => m.role !== 'system');
  const res = await fetch(provider.baseURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: effModel, max_tokens: 4096, system, messages: convo, tools: toolDefsForRequest().map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) }),
    signal
  });
  if (!res.ok) throw new Error(friendlyProviderError(provider.label, res.status, await res.text()));
  const data = await res.json();
  if (data.usage) lastUsage = { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens, totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0) };
  const toolCalls = data.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input }));
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { assistantText: text, toolCalls, rawMessage: data };
}
async function callProvider(effModel, signal) {
  if (provider.kind === 'openai-chat') return callOpenAIChat(effModel, signal);
  if (provider.kind === 'anthropic-messages') return callAnthropicMessages(effModel, signal);
  throw new Error(`Unsupported provider kind: ${provider.kind}`);
}

let busy = false;
let currentAbortController = null;
let stopRequested = false;
let lastUsedModel = null; // the model actually used for the most recent provider call — matters in Auto mode, where it can differ from the manually-selected `model`

async function runAgentLoop(turnStartIndex) {
  busy = true;
  stopRequested = false;
  const maxRounds = approvalMode === 'full' ? 200 : 12; // Full Access keeps going instead of stopping to ask; still capped so a genuine runaway loop can't run forever unattended
  const autoActive = autoModeEnabled && providerName === 'openrouter';
  const promptText = (messages[turnStartIndex - 1] && typeof messages[turnStartIndex - 1].content === 'string') ? messages[turnStartIndex - 1].content : '';
  let recentFailures = 0;
  try {
    for (let round = 0; round < maxRounds; round++) {
      if (stopRequested) { broadcast({ type: 'stopped' }); return; }
      const effModel = autoActive ? chooseAutoModel({ promptText, round, recentFailures, profileName: autoProfileName }) : model;
      lastUsedModel = effModel;
      broadcast({ type: 'thinking', model: autoActive ? effModel : undefined });
      currentAbortController = new AbortController();
      let result;
      try { result = await callProvider(effModel, currentAbortController.signal); }
      catch (err) {
        if (err.name === 'AbortError') { broadcast({ type: 'stopped' }); return; }
        broadcast({ type: 'error', message: err.message }); return;
      } finally { currentAbortController = null; }
      broadcast({ type: 'usage', usage: lastUsage, contextLimit: contextLimitFor(effModel), model: autoActive ? effModel : undefined });
      fetchKeyQuota().then(q => { if (q) broadcast({ type: 'quota', quota: q }); });

      const isFinal = result.toolCalls.length === 0;
      if (result.assistantText) broadcast({ type: 'assistant_message', text: result.assistantText, final: isFinal, turnStart: turnStartIndex });
      messages.push(provider.kind === 'openai-chat' ? stripThinkingBlocks(result.rawMessage) : stripThinkingBlocks({ role: 'assistant', content: result.rawMessage.content }));

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
        if (!toolResult.ok) recentFailures++;

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
    broadcast({ type: 'idle', usage: lastUsage, contextLimit: contextLimitFor(lastUsedModel || model), quota: keyQuota });
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
  saveLastState();
  savePerProjectLastSession();
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
const MAX_BODY_BYTES = 60 * 1024 * 1024; // ~60MB raw (base64 upload payloads are ~33% larger than the source file, so this allows roughly ~45MB files)
function readBody(req) {
  return new Promise((resolve) => {
    let chunks = '';
    let bytes = 0;
    let tooLarge = false;
    req.on('data', c => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) { tooLarge = true; req.destroy(); return; }
      chunks += c;
    });
    req.on('end', () => {
      if (tooLarge) { resolve({ __tooLarge: true }); return; }
      try { resolve(JSON.parse(chunks || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
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
      autoMode: autoModeEnabled, autoProfile: autoProfileName,
      autoProfiles: Object.entries(AUTO_PROFILES).map(([id, p]) => ({ id, label: p.label, fast: p.fast, capable: p.capable })),
      aaStatus: {
        configured: !!process.env.AA_API_KEY,
        fetchedAt: aaCache.fetchedAt,
        modelCount: aaCache.data.length,
        error: aaCache.error,
        openRouterModelCount: openRouterModelIdsCache.length
      },
      sessions: listSessions(), history: historyForClient(),
      providers: Object.entries(PROVIDERS).map(([name, p]) => ({ name, label: p.label, defaultModel: p.defaultModel })),
      bookmarks: loadBookmarks(),
      usage: lastUsage, contextLimit: contextLimitFor(lastUsedModel || model), lastUsedModel, quota: keyQuota
    });
  }

  if (url.pathname === '/api/mode' && req.method === 'POST') {
    const { mode } = await readBody(req);
    if (!VALID_MODES.has(mode)) return send(res, 400, { ok: false, error: `Invalid mode. Must be one of: ${[...VALID_MODES].join(', ')}` });
    approvalMode = mode;
    return send(res, 200, { ok: true, mode: approvalMode });
  }

  if (url.pathname === '/api/automode' && req.method === 'POST') {
    const { enabled, profile } = await readBody(req);
    if (profile !== undefined) {
      if (!AUTO_PROFILES[profile]) return send(res, 400, { ok: false, error: `Unknown profile "${profile}". Must be one of: ${Object.keys(AUTO_PROFILES).join(', ')}` });
      autoProfileName = profile;
    }
    if (enabled !== undefined) autoModeEnabled = !!enabled;
    if (autoModeEnabled && providerName !== 'openrouter') {
      return send(res, 200, { ok: true, autoMode: autoModeEnabled, autoProfile: autoProfileName, warning: 'Auto mode picks models from OpenRouter\u2019s catalog — switch the provider to OpenRouter for it to actually take effect.' });
    }
    return send(res, 200, { ok: true, autoMode: autoModeEnabled, autoProfile: autoProfileName });
  }

  if (url.pathname === '/api/automode/refresh' && req.method === 'POST') {
    if (!process.env.AA_API_KEY) return send(res, 200, { ok: false, error: 'No AA_API_KEY set in .env — add one from artificialanalysis.ai/data-api to enable live rankings.' });
    await refreshAutoModeData();
    return send(res, 200, {
      ok: !aaCache.error,
      error: aaCache.error,
      fetchedAt: aaCache.fetchedAt,
      modelCount: aaCache.data.length,
      openRouterModelCount: openRouterModelIdsCache.length
    });
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
  if (url.pathname === '/api/session/archive' && req.method === 'POST') {
    const { name } = await readBody(req);
    if (!name) return send(res, 400, { ok: false, error: 'name required' });
    const result = archiveSession(name);
    if (!result.ok) return send(res, 400, result);
    if (name === sessionName) switchSession('default'); // don't leave the active chat pointed at something now hidden
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/session/unarchive' && req.method === 'POST') {
    const { name } = await readBody(req);
    if (!name) return send(res, 400, { ok: false, error: 'name required' });
    const result = unarchiveSession(name);
    return send(res, result.ok ? 200 : 400, result);
  }
  if (url.pathname === '/api/sessions/archived' && req.method === 'GET') {
    const all = listSessions(true);
    return send(res, 200, { ok: true, sessions: all.filter(s => s.archived) });
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
    switchSession(loadPerProjectLastSession()); // resume wherever you left off in *this* project, not always "default"
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

  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.__tooLarge) return send(res, 413, { ok: false, error: 'File too large — 45MB limit per upload.' });
    const { filename, contentBase64, subdir } = body;
    if (!filename || typeof contentBase64 !== 'string') return send(res, 400, { ok: false, error: 'filename and contentBase64 required' });
    // basename-only — never let a filename traverse outside the target directory, upload dir stays under ROOT regardless of what the client sends
    const safeName = path.basename(filename).replace(/[\x00-\x1f]/g, '').trim();
    if (!safeName) return send(res, 400, { ok: false, error: 'Invalid filename' });
    const targetDir = subdir ? path.resolve(ROOT, subdir) : ROOT;
    if (!targetDir.startsWith(path.resolve(ROOT))) return send(res, 400, { ok: false, error: 'Invalid subdir' });
    try {
      await fsp.mkdir(targetDir, { recursive: true });
      const destPath = path.join(targetDir, safeName);
      const buf = Buffer.from(contentBase64, 'base64');
      await fsp.writeFile(destPath, buf);
      return send(res, 200, { ok: true, path: destPath, relativePath: path.relative(ROOT, destPath), bytes: buf.length });
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message });
    }
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
      const models = (data.data || [])
        .filter(m => m.id)
        .map(m => {
          if (m.context_length || m.context_window) modelContextLimits[m.id] = m.context_length || m.context_window;
          let price = null;
          // OpenRouter (and some OpenAI-compatible servers) include per-token USD pricing on each model entry
          if (m.pricing && (m.pricing.prompt || m.pricing.completion)) {
            const promptPerM = Number(m.pricing.prompt) * 1e6;
            const completionPerM = Number(m.pricing.completion) * 1e6;
            if (isFinite(promptPerM) && isFinite(completionPerM)) {
              price = { promptPerM, completionPerM };
              modelPricing[m.id] = price;
            }
          }
          return { id: m.id, price };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
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

restoreLastState(); // pick up wherever the last session left off, if that project folder still exists
ensureHelperScripts();
refreshAutoModeData(); // fire-and-forget — populates AA rankings + OpenRouter model ids if AA_API_KEY is set; auto mode falls back to static lists until this completes
setInterval(refreshAutoModeData, AA_REFRESH_INTERVAL_MS);
findOpenPort(4174, (port) => {
  server.listen(port, '127.0.0.1', () => {
    console.log(`codex-agent GUI server running at http://localhost:${port}`);
    console.log(`Working directory: ${ROOT}`);
    // Let the launcher script handle opening the browser window; also print
    // the URL in case it needs to be opened manually.
    fs.writeFileSync(path.join(__dirname, '.port'), String(port), 'utf-8');
  });
});
