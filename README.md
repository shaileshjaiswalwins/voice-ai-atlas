# Voice AI Atlas

An explorable architecture map of a production Hindi-language voice-AI system —
an outbound phone agent that qualified marketplace buyer leads at scale, and the
post-call pipeline that decided what each conversation was worth.

Two views, one source. An **interactive isometric map** you click around, and a
**generated document** (`SYSTEM.md`) with the decisions table, every component,
and every open question. Both are built from a single data file.

> Companion to **[voice-ai-dashboard](https://github.com/shaileshjaiswalwins/voice-ai-dashboard)**,
> which maps the no-code platform that configured these bots. This repo is the
> bot; that one is the platform.

---

## Run it

Needs Node 18+. Nothing to install — no dependencies.

```bash
git clone <this repo>
cd voice-ai-atlas
node atlas/build.mjs
open atlas.html          # macOS  ·  Linux: xdg-open  ·  Windows: start
```

That's it. `atlas.html` is one self-contained file.

If your browser blocks local fonts over `file://`, serve the folder instead:

```bash
npx serve .        # or: python3 -m http.server 8000
```

### Reading the map

| Key | Does |
|---|---|
| `]` / `Next ▸` | Next chapter |
| `[` / `◂ Back` | Previous chapter |
| hover | Read a component |
| click | Pin it open |
| `→` | Go inside — see its execution steps |
| `←` | Come back out |
| click a moving dot | Inspect the data it carries |

Eleven chapters, revealed a few components at a time. The last one shows the
whole system with a flow picker.

---

## What it maps

A buyer posts a requirement. A dialer rings them, and the answered call lands in
a LiveKit room where one worker picks it up. That worker re-reads a four-line
YAML file **on every single call** and decides which of three conversation
architectures answers — a speech-to-speech model, a vendor-voiced pipeline, or
one of three self-hosted Hindi voices picked by weighted random draw. Editing
that file changes what the next caller hears. No deploy, no restart.

The chosen bot fetches the buyer's lead, builds a Hindi system prompt around the
specification questions that buyer's product category demands, and runs a
speech-to-text → LLM → text-to-speech loop for at most five minutes — capturing
audio even while its own microphone is muted, so nothing the caller says is lost
to the bot's own voice.

When the call ends, the transcript is written down and marked unread. A minute
later a separate worker reads it back against a twenty-outcome rubric, scores
commercial intent, and reports the verdict upstream. Because every call records
which voice spoke it, the weights in that YAML file are a running production A/B
test.

**Seventeen components across eleven chapters**, including:

- the per-call mode dispatcher and the live switch it reads
- the three-stage conversation pipeline and its watchdogs
- muted-window audio capture and batch re-transcription
- a self-hosted TTS plugin that survives a voice silently refusing to speak
- the twenty-outcome disposition rubric, and what it decides without an LLM
- the payload builder that repairs what speech recognition mangled

---

## Why it exists

Most architecture docs describe the shape and lose the reasoning. This one keeps
both. Every component carries its open questions, and the ones that were settled
carry the answer and the date. The decisions table records nine calls that were
hard to reverse, including one the team flagged in writing as *"a bigger bet than
the data alone justifies"* — which is the kind of thing that normally never
survives into documentation.

Some of what it records:

- Why the greeting is a fixed recording rather than generated
- Why name transliteration was pulled out of the conversational model into its
  own single-purpose call (a ~41% failure rate, measured)
- Why text is normalized by Unicode category rather than `\w` (Devanagari vowels
  are combining marks, and `\w` silently eats them)
- Why analysis is persisted *before* the callback is attempted
- Why a rupee amount must never have "units" appended to it

---

## Editing it

`atlas/data.mjs` is the only file you edit. Everything else is generated.

| File | What | Edit? |
|---|---|---|
| `atlas/data.mjs` | Components, flows, chapters, decisions, questions | ✅ **This one** |
| `atlas/build.mjs` | Generator | ❌ |
| `atlas/template.html` | The isometric renderer | ❌ |
| `SYSTEM.md` | Generated document | ❌ regenerate |
| `atlas.html` | Generated map | ❌ regenerate |

Change `data.mjs`, run `node atlas/build.mjs`, reload. Both views stay in sync
because there is only one source.

Questions carry a state: open (a string), resolved (`{q, r}` with the answer and
date), or routed (`{q, to}`). Currently **27 open · 9 resolved**.

---

## Anonymization

This is a case study, not a code dump. The company name is replaced with "the
marketplace", and internal hostnames are placeholders (`mis-api.internal`,
`mongo.internal`, `tts.internal`). No source code, credentials, customer data, or
real endpoints are included. The architecture, the decisions, and the reasoning
are as they were.

---

## Credits

Built by **Shailesh Jaiswal** — architecture and reasoning from the system his
team designed and ran in production.

The atlas format (isometric renderer, progressive disclosure, generated text
twin) comes from the `system-atlas` skill.

---

**Live map:** https://claude.ai/code/artifact/d35d4ab4-dc99-4985-9bd9-5dc2da12f509
