# codex-agent (GUI edition)

A real chat window instead of Terminal — same file/shell/Arduino/serial/
logic-analyzer capabilities as the CLI edition, plus persistent chats,
session switching, and git project navigation, all in a proper app UI.

Comes pre-configured to use **OpenRouter** with the key you gave me baked
in as the default (rotate it on openrouter.ai/keys when you get a chance —
see the security note at the bottom).

## Get started

1. Install [Node.js](https://nodejs.org) (LTS) if you don't have it.
2. Double-click **`start.command`** (Mac) — or `start.bat` (Windows) /
   `start.sh` (Linux).

   **Don't run it with `node start.command`** — that file is a shell
   script, not JavaScript (`node` will fail to parse it). Double-click it,
   or from Terminal run `./start.command` (or `bash start.command`).
   `server.js` is the actual JavaScript file, but you shouldn't need to run
   it directly — the launcher does that for you.

First time on Mac: right-click `start.command` → **Open** once (Gatekeeper
blocks unsigned scripts on a plain double-click the first time — see the
Troubleshooting section).

This starts a small local server and opens a **real app window** — if you
have Chrome, Brave, or Edge installed, it opens in "app mode" (no address
bar or tabs, just the chat UI, like a native app); otherwise it opens in
your default browser as a normal tab.

A Terminal window will also appear behind it — that's the server console,
not the interface. Leave it running; closing it stops the agent. (This
avoids needing Electron, which would mean a 150MB+ unsigned download with
the same Gatekeeper friction, for no real benefit here.)

## What you get

- **Chat window** with your conversation and replies rendered as real
  formatted text — bold, tables, code blocks, lists, headers — not raw
  markdown symbols.
- **Only the last 2 turns show in full detail.** Every turn — your
  message, any interim "let me check X" notes, tool activity, and the
  final answer — collapses into one line like "▸ what was that bug fix ✓"
  once it's more than 2 turns back. Click it to expand and see the full
  exchange again, or leave it collapsed. As you keep chatting, the window
  slides forward automatically — always the 2 most recent turns fully
  visible, everything older tucked away. Within a turn, tool calls and
  interim notes are further folded into a "▸ N steps" sub-summary so even
  the visible turns stay tidy.
- **Edit and resend your own messages.** Hover any message you sent, click
  ✎, edit the text inline, then "Save & resend" — this drops that message's
  old answer (and everything after it) and asks again with the new
  wording. Same idea as editing a message in a regular chat app.
- **Stop button** appears next to Send while the agent is working — cancels
  the in-flight request immediately (a real abort, not just "stop after
  this step") and leaves everything up to that point exactly as it was, so
  you can edit your last message or just send a new one.
- **Keep typing while it's working.** The input box never locks — send
  (or hit Enter) while the agent is mid-reply and your message queues
  instead of erroring, shown in a small panel above the input. Queued
  messages send automatically, one after another, once the agent's free.
  Each queued item also has **▶ steer now**, which interrupts whatever's
  currently running and sends that one immediately — skipping ahead of
  anything else waiting — for when you realize partway through a long
  task that you need to redirect it right away rather than wait.
- **Token usage**, top right — updates live while the agent is working
  (after every individual step, not just once the whole turn finishes),
  showing tokens used and, when known, how many are left in the selected
  model's context window (e.g. `1.3k used · 126.7k left`). The limit is
  pulled live from OpenRouter/OpenAI/Groq's model list (hit the ↻ button
  next to the model field at least once to populate it) or a small
  built-in fallback table for Anthropic models.
- **Approval popups**: whenever the agent wants to write a file, run a
  shell command, flash an Arduino, or capture a logic-analyzer trace, a
  card pops up asking Approve/Deny instead of a terminal `y/n` prompt —
  unless you've switched modes (below).
- **Three approval modes**, switchable any time from the top bar dropdown:
  - **Approve Each Action** (default) — the popup above, every time.
  - **Full Access** — never asks; every tool call runs immediately, and
    the agent keeps working through up to 200 tool rounds in a row instead
    of pausing at 12 like the other modes. Only use this in a
    folder/sandbox you fully trust, since the agent can run arbitrary
    shell commands unattended. Stop still works to interrupt it any time.
  - **Read Only** — the agent literally isn't given the ability to write
    files, run commands, flash hardware, or capture signals; those tools
    aren't even offered to the model in this mode, so it can inspect and
    explain but never change anything. Good for "just look and tell me"
    tasks or handing the agent to someone you don't want mutating things.
- **Provider/model switcher** in the top bar — change providers without
  editing any file, and type or pick **any** model string for that
  provider. Click the ↻ button to pull a live model list straight from the
  provider (works for OpenRouter, OpenAI, Groq, and any local
  OpenAI-compatible server) — with OpenRouter that's hundreds of models
  across every major lab. Each row in the dropdown shows per-token pricing
  when the provider supplies it (e.g. `$2.50 in / $10.00 out per M`, or
  `free` for no-cost models) — OpenRouter includes this for essentially
  every model, so you can compare cost at a glance while picking. The
  field is always free-typeable too, so you're never limited to what's in
  the dropdown.
- **🤖 Auto — smart model routing** (button next to the model field,
  OpenRouter only): instead of picking one model for the whole
  conversation, it picks per step — starting cheap and only escalating to
  a stronger model when the task actually seems to need it. While it's on,
  the model field goes read-only and shows whichever model is actively
  running right now, live, as it changes.

  Turning it on reveals a second dropdown to pick which **profile** to
  route with — each tuned with its own keyword triggers and its own
  choice of "capable" model for that domain:

  | Profile | Escalates on | Capable-tier model |
  |---|---|---|
  | **Hardware Debug** | voltage/signal-integrity language, "why", "intermittent", "troubleshoot" | Claude Sonnet 4.6 |
  | **Embedded / Firmware** | interrupts, watchdog resets, RTOS, heap/stack corruption, race conditions | Claude Sonnet 4.6, then o3-mini |
  | **FPGA / Verilog** | timing violations, clock-domain-crossing issues, metastability, simulation mismatches, stuck FSM states | **o3-mini first** — RTL/timing bugs are logic-heavy, so this profile prioritizes a reasoning-tuned model over plain Sonnet |
  | **General Coding** | exceptions, stack traces, memory leaks, flaky tests, "refactor" | Claude Sonnet 4.6 |

  Every profile also escalates regardless of keywords if a task is
  visibly struggling — 3+ tool-call rounds without a final answer, or 2+
  failed tool calls in the same turn — and once escalated, stays escalated
  for the rest of that turn.

  The FPGA profile deliberately does **not** escalate just because a
  message mentions "verilog", "testbench", "synthesis", "bitstream", etc. —
  those are just normal vocabulary for the domain and would appear in
  nearly every message, which would defeat the point. It only escalates on
  phrases that actually indicate a problem (timing violation, CDC issue,
  metastability, stuck state, negative slack...), so routine FPGA work
  stays on the cheap tier and genuine debugging still gets the stronger
  model. Verified end-to-end: "write a testbench for the UART module"
  stayed on the cheap model, "why is there a timing violation on the
  output path" correctly escalated to o3-mini, in the same session.

  Turning it on while on a non-OpenRouter provider shows a warning and
  does nothing until you switch providers — it needs OpenRouter's catalog
  to have multiple tiers to route between.

  **Live rankings, not just a hardcoded list.** By default each profile
  falls back to the hand-picked model lists above. But if you set an
  `AA_API_KEY` in `.env` — a free key from
  [artificialanalysis.ai/data-api](https://artificialanalysis.ai/data-api)
  — auto mode instead ranks models using **live** benchmark data:
  - **Hardware Debug** and **Embedded** rank by ArtificialAnalysis's
    **agentic index** (how well a model performs in real tool-calling
    workflows — exactly what debugging over `run_command`/`read_file`
    actually is).
  - **FPGA** and **General Coding** rank by their **coding index**.
  - The "fast" tier picks whichever matching model has the best
    index-per-dollar (best value); the "capable" tier picks whichever has
    the highest raw index, price aside — that's the point of escalating.
  - Refetches automatically every 6 hours while the app is running (plus a
    manual ↻ button next to the profile dropdown), so the ranking tracks
    new model releases and re-scoring without needing a restart. The
    status text next to it shows either `live rankings · N models ·
    updated Xm ago` or `static lists (no AA_API_KEY set)`.

  One real limitation worth knowing: ArtificialAnalysis's free tier
  doesn't include a direct OpenRouter model-id mapping (that's a paid-tier
  field), so this matches their model slugs to OpenRouter's naming itself
  — exact match first, then a version-boundary-aware fallback (so
  `claude-sonnet-4` correctly matches OpenRouter's `claude-sonnet-4.6`
  without `gpt-4o` ever incorrectly matching `gpt-4o-mini`). It's
  best-effort: if a top-ranked model can't be matched to a real OpenRouter
  id, it's skipped in favor of the next-best one that can. Verified with a
  dedicated test suite covering exact matches, version-format mismatches,
  and the specific mini-vs-full-model ambiguity case.

  Want different models per profile, a different data source, or a
  profile for something else entirely? Edit the `AUTO_PROFILES` object
  near the top of `server.js` for the static fallback lists, or
  `AA_CATEGORY_BY_PROFILE` to change which live index each profile ranks
  by.
- **Persistent chats**: everything auto-saves per project folder, same as
  the CLI edition — closing and reopening the app picks up where you left
  off. Start a new thread, switch between saved ones, or delete old ones
  from the sidebar. Double-click a chat's name (or hit the ✎ icon) to
  rename it.
- **Branch or rerun a reply**: every assistant reply has a small footer
  row underneath it (not beside it — it hangs off the same left border as
  the reply itself, directly below the text) with two actions:
  - **↻ rerun this prompt** — only shown on a turn's final answer. Drops
    that answer (and any tool activity that produced it) and asks the
    model the same question again, unchanged. Useful when an answer wasn't
    great, or after switching models/providers and wanting to compare. For
    changing the question itself, use edit (above) instead.
  - **⑂ branch after this reply** — instantly forks the conversation up to
    exactly that point into a new chat, auto-named after what you were
    actually talking about (e.g. asking about "the auth flow" branches
    into something like `explain-the-auth-flow`, not a generic counter) —
    no naming prompt interrupts you. Rename it later from the sidebar if
    you want something different. Works on any reply, not just final ones,
    so you can fork off from a mid-task step too.

  All three of edit, rerun, and branch are disabled while the agent is
  mid-reply — stop it first if you want to act on an earlier message.
  Branched chats show a small ⑂ next to their message count in the
  sidebar (hover to see which chat they came from).

## Making projects from existing folders

The sidebar's **Projects** section is a persistent bookmark list — any
folder on your machine, git repo or not, that you want quick access to.
It survives restarts and isn't scoped to wherever you currently are.

- **Add a folder**: click "＋ browse for folder…" — opens a folder browser
  (breadcrumb path at top, click any subfolder to go deeper, "↑ .." to go
  up, "Select this folder" to confirm). It's reading real folders off your
  disk, not a browser file-picker, so it always gives the agent the real
  absolute path — no typing required.
- Click any bookmark to jump straight there — starts a fresh "default"
  chat for that folder (or resumes it, if you've been there before).
- Click ✕ to remove a bookmark (this only forgets it — the actual folder
  and its files are untouched).
- A 🔧 next to the name means that folder is a git repo.

Once you're in a project (bookmarked or via the "cd to folder" box), just
ask normally — the agent has full shell access (`run_command` under the
hood) so it can run `git clone`, `git status`, `npm install`,
`npm run build`, tests, etc. directly.

## Swapping the key or model

You don't need to edit any file. Create a `.env` next to `server.js`:

```ini
DEFAULT_PROVIDER=openrouter
DEFAULT_MODEL=anthropic/claude-sonnet-4.6
OPENROUTER_API_KEY=sk-or-v1-your-new-key
```

For local servers (Ollama, LM Studio, vLLM, etc.) or several at once, drop
a `providers.local.json` next to `server.js` — same format as in the CLI
edition's docs. They'll show up in the provider dropdown automatically.

## Troubleshooting

**"Apple could not verify start.command is free of malware"**
Right-click `start.command` → Open (shows a real Open button, unlike the
double-click block) — or once via Terminal: `xattr -d com.apple.quarantine start.command`

**Nothing opens / blank page**
Check the Terminal window for errors. Most common cause: something else is
already using port 4174+ — the server automatically tries the next port up,
so this is rare, but the exact URL is always printed in that Terminal window.
(The server also works if `index.html` ends up next to `server.js` instead
of inside `public/` — e.g. if a zip/download flattened the folder — so this
shouldn't happen from that specific issue anymore.)

**"command not found: node"**
Node.js isn't installed — get it from nodejs.org, or `brew install node` /
`conda install -c conda-forge nodejs` if you use those.

## Security note

The OpenRouter key baked into `server.js` was shared in a chat, so treat it
as semi-exposed — rotate it on openrouter.ai/keys once convenient, and put
the new one in `.env` rather than editing the file directly. The server
only listens on `127.0.0.1` (localhost), so it's not reachable from your
network or the internet.
