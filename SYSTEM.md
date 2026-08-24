# Voice AI Atlas — System Definition

_**An anonymized architecture case study.** This file is the single source of truth; the interactive atlas and this document are both generated from it. It describes a Hindi-language outbound voice-AI system that qualified marketplace buyer leads over the phone — what ran in production, and why each piece is shaped the way it is. Company name and internal endpoints have been replaced with placeholders._

_Question status: **27 open · 9 resolved**._

## One paragraph

A buyer posts a requirement on the marketplace. The telephony trunk rings them and drops the call into a LiveKit room; one worker process, `bot_main.py`, picks it up. On every single call it re-reads `bot_mode.yaml` from disk and decides — live, without a restart — which architecture answers: a Gemini Live speech-to-speech bot, a Sarvam-voiced pipeline, or (what production runs today) one of three self-hosted IndicF5 Hindi voices chosen by weighted random draw. The chosen bot fetches the buyer's lead from the MIS API, builds a Hindi system prompt around that lead's qualification questions, and runs a Sarvam-STT → Gemini-LLM → IndicF5-TTS loop for at most five minutes, capturing audio even while its own microphone is muted so nothing the buyer says is lost. When the call ends the transcript lands in MongoDB tagged `tagged: false`. A separate long-running worker polls that collection every 60 seconds, re-reads each transcript with Gemini against a twenty-entry disposition rubric, scores B2B intent, maps the stated city onto the marketplace's fixed city list, and posts the verdict back to the MIS callback API. Because every call records which voice spoke it, the weights in `bot_mode.yaml` are a running production A/B test.

## Decisions locked

| Axis | Decision | ADR |
|---|---|---|
| Mode switching | `bot_mode.yaml` is read fresh on every incoming call, never cached — changing architecture or voice weights takes effect on the next call with no worker restart | — |
| Live architecture | `own_voice` — the Sarvam-STT → Gemini-LLM → IndicF5-TTS pipeline, not Gemini Live s2s. Gemini Live and the Sarvam voice stay wired and runnable as fallbacks | — |
| Voice split | anushka 40 / niharika 40 / simran 20, set 2026-07-25. Niharika equal-weighted with Anushka on a 4-day Enriched trend despite a much shorter track record — recorded in the yaml as a deliberate bet, not a data-driven one | — |
| TTS quality knob | `nfe_step` pinned to 8 for 100% of calls (2026-07-22) to shave latency — with a verified note that this will *not* fix the 10–20s dead-air gaps, which are LLM thinking plus watchdog re-inject loops | — |
| Transliteration | Company, product and option names are transliterated to Devanagari by a narrow single-purpose LLM call before prompt build, never by the live conversational LLM (~41–43% Latin-leak measured, 2026-07-23/24) | — |
| Question text | A qualification question's `text` is *translated* into natural Hindi by the live LLM; only its option labels are mechanically transliterated. The original English schema is what persists to Mongo and what analysis matches against | — |
| Analysis cost | B2B scoring is skipped entirely for the 8 terminal/negative outcomes in `B2B_SCORE_SKIP_OUTCOMES`, sequentially after the outcome is known rather than gathered in parallel (2026-07-22) | — |
| Durability | Analysis is persisted to the transcript document *before* the callback is attempted, so a failed callback retries on the next tick without re-paying for the LLM | — |
| City handling | `up_usr_city` keeps exactly what the buyer said, forever. `mapped_city` is a separate additional field holding the LLM's best match against `data/city_list.json` | — |

## Cost model

Per-call LLM spend has three parts, all Gemini 3.1 Flash Lite unless noted:

| Call | When | Notes |
|---|---|---|
| Conversational LLM | every turn, during the call | `gemini-3.1-flash-lite`, temperature 0.4, full Hindi system prompt |
| Transliteration | once per lead, up front | `gemini-3.1-flash-lite-preview`, narrow single-purpose call, cached in `_TRANSLIT_CACHE` — replaced asking the live LLM inline, which was measured at ~41–43% Latin-leak (2026-07-23/24 audit) |
| Post-call analysis | once per transcript | `generate_call_analysis` against the 20-outcome `DISPOSITION_MAP` |
| B2B score | once per transcript, **conditionally** | skipped entirely for the 8 outcomes in `B2B_SCORE_SKIP_OUTCOMES` — a deliberate cost cut on 2026-07-22, sequential rather than gathered so the skip decision can be made first |

TTS cost is infrastructure, not per-token: IndicF5 runs on our own box at `tts.internal:8404`. Its `nfe_step` knob trades latency for quality (8 fast / 16 balanced / 32 best) and is pinned to 8 for 100% of calls since 2026-07-22.
## Deep dives

The `bot_mode.yaml` comment block is itself an ongoing experiment log — it records each weight change with the metric that justified it, the z-score, and, on 2026-07-25, an explicit note that equal-weighting Anushka and Niharika was "a bigger bet than the data alone justifies". That honesty is worth preserving; it is the only place the reasoning behind the live traffic split is written down.

## Reading order (the atlas chapters)

1. **A call is answered** — Strip everything away and this is the system: a phone is answered, and one process decides what happens next. _(adds TEL, MAIN)_
2. **The switch on the wall** — A four-line YAML file decides which architecture — and which voice — answers the next caller. _(adds YAML, VP)_
3. **Listening and thinking** — The bot proper: hearing turned into text, text turned into a Hindi reply. _(adds PIPE, STT, LLM)_
4. **Speaking in our own voice** — The three named voices run on our own hardware, which is why the quality dial is ours to turn. _(adds TTS)_
5. **Knowing who is on the line** — The bot does not invent the questions — the lead record decides what this call is about. _(adds MIS)_
6. **What the call leaves behind** — The bot writes one document and marks it unread. That flag is the entire handoff. _(adds MONGO)_
7. **Reading the call back** — A minute later, something reads the transcript and decides what the call was actually worth. _(adds CBW, AN)_
8. **Sending the verdict home** — The last chance to repair a call before it becomes a record someone acts on. _(adds CITY, CB)_
9. **Auditing our own judgement** — If a model decides what a call was worth, something has to check whether it keeps deciding the same way. _(adds OPS)_
10. **Paths not taken today** — Two architectures sit one line of YAML away — and one of them is load-bearing anyway. _(adds GEM, SOLO)_
11. **The whole system** — Everything at once, for free exploration.

## Structures

### The live call

#### M · Dispatcher

**In one line.** The single worker bound to the phone line — it decides, per call, which bot answers.

**What it does.** One process is registered with the telephony service. Rather than hard-wiring one bot to the line, it looks up the current setting the instant a call lands and hands the call to whichever architecture is configured. That is the reason the system can change its own voice mid-day.

**How it's built.** `bot_main.py`. Registers `WorkerOptions(entrypoint_fnc=dispatch_entrypoint, prewarm_fnc=bot_pipeline.prewarm_fnc, agent_name="voice-bot-marketplace", num_idle_processes=3)`. Its entrypoint calls `load_mode_config()` and branches: `gemini_live` → `bot.entrypoint(ctx)`; `sarvam` → `bot_pipeline.entrypoint(ctx, SARVAM_PROFILE)`; otherwise a **weighted random draw** over the IndicF5 voices, with a second independent draw for `nfe_step`.

**Steps in execution.**

1. **Read the switch** — Load <code>bot_mode.yaml</code> fresh — no caching, no restart.
2. **Branch on mode** — Three architectures, one line of yaml decides.
3. **Draw a voice** — On <code>own_voice</code>, <code>weighted_pick</code> over anushka/niharika/simran.
4. **Draw a quality step** — A second <code>weighted_pick</code> over <code>nfe_step</code>, so latency-vs-quality is A/B tested in production too.
5. **Log the choice** — One <code>[MODE]</code> line records room, mode, voice_name and nfe_step — the audit trail for the experiment.
6. **Hand off** — Call the chosen entrypoint with the chosen profile.

**Questions.**

- ~~**Q-M1** What happens if the yaml is unreadable mid-call-storm?~~ ✓ `load_mode_config()` catches OSError/YAMLError, logs a warning and falls back to `own_voice` with the default 50/25/25 weights — calls never fail on a bad edit (2026-08-24).
- **Q-M2** Nothing validates that `num_idle_processes=3` is still the right pool size for current call volume — is it?

#### Y · The live switch

**In one line.** A four-line YAML file that is the whole control panel for which bot production runs.

**What it does.** Editing this file changes what the next caller hears. There is no deploy, no restart, no flag service. It also carries a written record of every weight change and the numbers that justified it — the closest thing the system has to a lab notebook.

**How it's built.** `bot_mode.yaml`, read by `bot_mode_config.load_mode_config()` (override the path with `$BOT_MODE_CONFIG`). Three keys: `mode` (`gemini_live` | `sarvam` | `own_voice`), `own_voice_weights`, `nfe_step_weights`. `_clean_weights()` coerces unknown or invalid entries back to defaults and falls back to the full default set if everything sums to zero. Currently **anushka 40 / niharika 40 / simran 20**, `nfe_step 8: 100`.

**Steps in execution.**

1. **Edit** — Change a number, save.
2. **Next call** — The dispatcher re-reads the file — the change is live.
3. **Record** — The comment block above each block explains why the number is what it is, with dates and z-scores.

**Questions.**

- ~~**Q-Y1** Why extract the reader into `bot_mode_config.py` rather than leave it in `bot_main.py`?~~ ✓ Because `bot_dev.py` had no reader at all and hard-coded Simran, so dev kept ignoring the weights. One shared module keeps both entrypoints honest (recorded in the module docstring).
- **Q-Y2** Simran keeps 20% of traffic while her 69.5% Short Hangup rate is investigated — is that investigation still open, and where is it tracked?
- **Q-Y3** The weight history lives only in YAML comments. If someone reformats the file, the experiment log is gone — should it move somewhere durable?

#### P · Pipeline session

**In one line.** The bot itself — a five-minute Hindi conversation stitched together from speech-to-text, a language model, and a voice.

**What it does.** This is where the call actually happens. It greets the buyer by name, works through the qualification questions the MIS API returned for their product, notices when they change what they want, notices when it has reached a machine instead of a person, notices when they are winding down, and hangs up gracefully. Most of its two and a half thousand lines are not the conversation — they are the guards around it.

**How it's built.** `bot_pipeline.py`, entrypoint at line 266, seventeen numbered sections. `AgentSession(stt, llm, tts, turn_detection="stt")`. Business logic is imported wholesale from `bot.py` (prompt builder, lead fetch, transcript builder, closing/abuse detection, Silero gating) so the two architectures stay behaviourally identical. Hard call cap 300s. Barge-in is suppressed for the first 4 seconds of any reply. A **muted-window capture** subscribes to the raw audio track directly so the caller is still recorded while the bot's own mic is off, then batch-transcribes that window through Sarvam and injects it.

**Steps in execution.**

1. **1 · Pre-fetch the lead** — Fire <code>fetch_lead()</code> before <code>ctx.connect()</code> so the MIS round-trip overlaps room join.
2. **2 · Resolve config** — <code>fetch_bot_config(assistant_id)</code>, falling back to <code>_HARDCODED_BOT_CONFIG</code>. Sets thresholds: silero 0.6, min speech 1000ms, inactivity 4/4/10/5s.
3. **4 · Build the prompt** — Transliterate company/product/option names to Devanagari first, then <code>build_system_prompt()</code> with the persona, the LB1 city flow and the buyer-assist flow.
4. **5 · Wire the plugins** — Sarvam <code>saaras:v3</code> STT → Gemini <code>3.1-flash-lite</code> → IndicF5 or Sarvam <code>bulbul:v3</code> TTS. Pre-synthesize the hold message and the noise nudge.
5. **7 · Function tools** — <code>FetchLead</code> and <code>FetchCategorySchema</code>, the latter guarded by a seller/manufacturer token block and cushioned by a cached "एक क्षण रुकिए" hold line.
6. **9 · Event handlers** — <code>user_input_transcribed</code>, <code>agent_state_changed</code>, <code>conversation_item_added</code>, <code>metrics_collected</code> — plus the response watchdogs.
7. **10 · Muted-window capture** — Rolling 5s PCM buffer; frames captured while muted are wrapped as WAV and posted to Sarvam batch STT in <code>codemix</code> mode.
8. **13 · Greet** — A deterministic pre-composed greeting via <code>session.say()</code> — never generated, so the opener can never come out wrong.
9. **14–15 · Timers** — 300s hard timeout; a three-strike inactivity ladder capped by <code>_STALL_RESET_CAP = 6</code> so a noisy line cannot loop silently forever.
10. **Save** — Build the transcript, compute duration and average latency, insert one document into MongoDB with <code>tagged: false</code>, delete the room.

**Questions.**

- ~~**Q-P1** Why is the greeting spoken rather than generated?~~ ✓ A generated opener was measured as sometimes wrong; a fixed `session.say()` makes `wrong_opener_detected` structurally impossible, which is why the pipeline hard-codes it to `False` in the Mongo doc.
- **Q-P2** The `[LLM-WATCHDOG]` cancel/re-inject cycles stack into 10–20s of dead air. `nfe_step=8` was verified *not* to fix it. What does?
- **Q-P3** Nine watchdog cancel/re-schedule sites touch `_bot_resp_watchdog_task`. Is there a single place that owns its lifecycle, or is that invariant only held by convention?
- **Q-P4** The entrypoint is one ~2,400-line function with `# noqa: C901`. Which of its seventeen sections could become testable units without changing behaviour?

#### V · Voices

**In one line.** Four interchangeable personalities — one Sarvam voice and three of our own — each a small frozen record of everything that differs between them.

**What it does.** Swapping the voice used to mean swapping a whole file. Now a voice is a handful of fields: which engine speaks, which speaker name, what she calls herself, her greeting, and whether her prompt needs the extra Hindi-script coaching. Which one a caller gets is decided by the dice roll in the dispatcher, and recorded on the call so the experiment can be scored later.

**How it's built.** `voice_profiles.py` — a frozen `@dataclass VoiceProfile`. `SARVAM_PROFILE` reads Latin script natively and deliberately keeps `persona_name="Simran"` so the base prompt is left byte-for-byte unchanged. The three `INDIC_PROFILES` set `tts_transliterate=True` and carry `_TTS_CACHE_HINT` plus `_TRANSLITERATION_HINT`. Each also lists `extra_echo_markers` (e.g. `"अनुष्का बोल रही"`) so the bot can recognise its own voice bleeding back through the line. `voice_name` is what gets persisted for A/B scoring.

**Steps in execution.**

1. **Pick** — The dispatcher draws a profile from <code>INDIC_PROFILES</code>.
2. **Shape the prompt** — <code>extra_prompt_hints</code> are appended for IndicF5 voices only.
3. **Shape the audio** — <code>engine</code> selects the TTS plugin; <code>nfe_step</code> is overlaid per call via <code>dataclasses.replace</code>.
4. **Record** — <code>voice_name</code> is written to Mongo and forwarded in the MIS callback.

**Questions.**

- **Q-V1** Three voices are already differentiated in production. Is anyone scoring the `voice_name` field on a schedule, or is it read ad hoc?
- ~~**Q-V2** Why do the IndicF5 profiles need `_TRANSLITERATION_HINT` at all if names are pre-transliterated?~~ ✓ Pre-transliteration only covers company, product and option names from the API. Ordinary Hinglish the LLM invents mid-sentence still needs the standing rule (2026-08-24).

### What the call talks to

#### T · Telephony + LiveKit room

**In one line.** The phone line — a SIP trunk that dials the buyer and drops the answered call into a LiveKit room.

**What it does.** When a buyer needs qualifying, the dialer places a call. The moment they pick up, the audio becomes a room that a bot can walk into. Everything the atlas shows downstream starts here.

**How it's built.** A LiveKit SIP trunk with a dispatch rule bound to `agent_name="voice-bot-marketplace"`. The room name carries the buyer's mobile (matched out with `__(\d{10,12})_`) and the room metadata carries `lead_id`, `assistant_id` and `call_id`. The caller's number and the dialed number are read afterwards from the SIP participant's attributes.

**Steps in execution.**

1. **Dial** — The outbound dialer rings the buyer.
2. **Answer** — A LiveKit room is created; the SIP participant joins.
3. **Dispatch** — The dispatch rule wakes the worker registered under the matching agent name.
4. **Attributes** — The bot reads <code>sip.phoneNumber</code> and the dialed number off the participant once the session is up.

**Questions.**

- ~~**Q-T1** Is the SIP trunk config version-controlled anywhere in this repo?~~ ✓ No — it lives on the LiveKit server, outside this branch. The repo only assumes the dispatch rule exists (2026-08-24).

#### S · Sarvam speech-to-text

**In one line.** Turns the caller's Hindi into text, twice over — live during the call, and in batches for the moments the bot was talking.

**What it does.** Hearing is used in two modes. Streaming, for the ordinary back-and-forth. And in batch, for the seconds when the bot had its own microphone switched off and would otherwise have missed the caller cutting in.

**How it's built.** `sarvam.STT(language="hi-IN", model="saaras:v3", mode="transcribe", flush_signal=True)` for the live stream, with Sarvam owning turn detection. The muted window posts a hand-built WAV to `https://api.sarvam.ai/speech-to-text` with `mode=codemix` and a 10s timeout. Final live transcriptions are gated by Silero (`_silero_voiced_ms`, threshold 0.6, min 1000ms) against a rolling 5-second PCM window — **rolling, not fill-then-drop**, because the mic unmutes 4s into a 10s bot turn and a fixed buffer filled with the bot's own echo starved the gate.

**Steps in execution.**

1. **Stream** — Frames flow while the mic is enabled.
2. **Gate** — A final transcription is checked against the Silero voiced-ms window before it counts as a turn.
3. **Buffer** — While muted, raw frames accumulate separately.
4. **Batch** — On unmute, the muted window is WAV-wrapped and transcribed, then injected as a turn.

**Questions.**

- **Q-S1** The muted-window path builds a fresh `aiohttp.ClientSession` per transcription rather than reusing the shared one — deliberate, or drift?

#### L · Gemini

**In one line.** The language model that carries the conversation, transliterates names, and later reads the whole call back.

**What it does.** The same family of model does three different jobs here, deliberately kept apart: one holds the conversation, one does nothing but convert English words into Hindi script, and one reads the finished transcript and decides what the call was worth. Splitting them was a measured decision, not a stylistic one.

**How it's built.** Conversation: `google.LLM(model="gemini-3.1-flash-lite", temperature=0.4)`. Transliteration: `gemini-3.1-flash-lite-preview`, a narrow single-purpose call cached in `_TRANSLIT_CACHE`. Analysis: `gemini-3.1-flash-lite` in the callback worker. The Gemini Live path additionally load-balances a key pool — `_next_gemini_key()` picks the least-inflight key, round-robins among ties, and **quarantines a key for 60s on a 409**, falling back to the soonest-to-recover key rather than failing the call.

**Steps in execution.**

1. **Prompt** — A Hindi system prompt built per lead, with per-question phrasing rules and a mandatory 2–4 word opening acknowledgement so the first TTS chunk plays in ~100ms.
2. **Turn** — One generation per user turn, with watchdogs re-injecting if no response arrives.
3. **Tools** — Two function tools it may call mid-conversation.
4. **Analyse** — Later, offline, a separate call reads the whole transcript against the disposition rubric.

**Questions.**

- **Q-L1** Key rotation and 409 cooldown live only in `bot.py` (the Gemini Live path). The live pipeline uses a single `GEMINI_API_KEY` — does it need the same protection at current volume?
- **Q-L2** The "start every reply with a 2–4 word acknowledgement" rule buys perceived latency. Has anyone measured whether it also costs a turn of quality?

#### F · IndicF5 voice server

**In one line.** Our own Hindi voice, synthesised on our own hardware over a websocket.

**What it does.** The three named voices are not a vendor product — they are fine-tuned models running on a box we own. That is why the quality-versus-speed dial is ours to turn, and why the plugin has to cope with a voice occasionally refusing to speak a line.

**How it's built.** `livekit_indic5_tts.IndicF5TTS`, a non-streaming `tts.TTS` talking to `ws://tts.internal:8404/ws` at 24kHz. Options carried per call: `nfe_step`, `speaker`, `transliterate`, `speed`, `style`. Some fine-tuned speakers intermittently return `{"event":"end","sentences":0,"suppressed":true}` with **zero audio and no error** — the plugin retries once with `fallback_speaker` so a suppressed line never becomes dead air on a live call.

**Steps in execution.**

1. **Synthesize** — One websocket request per utterance — this TTS does not stream.
2. **Detect suppression** — Zero frames plus <code>suppressed: true</code> is a silent failure, not an error.
3. **Retry** — Re-request once as <code>fallback_speaker</code> (default simran), unless that is already the speaker.
4. **Cache the canned lines** — The hold message and noise nudge are pre-synthesized once and replayed from frames.

**Questions.**

- **Q-F1** How often does the suppression fallback actually fire, and is it counted anywhere?
- **Q-F2** The server address is a bare LAN IP with no health check in the bot. What does a call do if the box is down when the greeting is due?

#### A · MIS lead API

**In one line.** the marketplace's system of record — where the buyer, their product, and the questions to ask them all come from, and where the verdict goes back.

**What it does.** The bot does not invent what to ask. Every call is shaped by a lead record fetched at the start: who the buyer is, what they searched for, and the list of specification questions their product category demands. When the call is over and analysed, the answers travel back to the same system.

**How it's built.** `http://mis-api.internal:8000`. Read: `fetch_lead(lead_id | mobile)` and `/leads/ai-lead-qualify/search` for a mid-call product change. Write: `/leads/ai-lead-qualify/callback` and `/callback-update`. The question set arrives as `results.search_result.question` and is stored on the lead as `qualification_schema["question"]`. Note the bot asks **more than the schema lists** — product confirmation, business name and city are hard-coded extra steps, by design.

**Steps in execution.**

1. **Pre-fetch** — Kicked off before room connect so the round-trip overlaps join.
2. **Log the questions** — Every question the backend returned is logged verbatim per call.
3. **Re-fetch on change** — <code>FetchCategorySchema</code> swaps the whole question set mid-call when the buyer changes product.
4. **Callback** — The analysed outcome is posted back after the call, with up to four `spec_ques_N` entries.

**Questions.**

- ~~**Q-A1** Why does the total number of asks exceed the backend question count?~~ ✓ By design — the BUSINESS GATE adds product confirmation, business name and city on top of the schema questions (noted inline in `bot_pipeline.py`).
- **Q-A2** `MIS_API_BASE` is a hard-coded LAN IP that `bot_pipeline.py` re-declares after importing it from `bot.py` — is the dev/live override still intentional?

### After the call

#### D · Call transcripts

**In one line.** One document per call, and the handoff point between the bot and everything that happens afterwards.

**What it does.** The bot never talks to the analysis step directly. It writes down what happened and marks the document unread; something else picks it up later. That one flag is the entire coordination mechanism, and it is what makes a failed callback safe to retry.

**How it's built.** `mongodb://mongo.internal:27017`, db `ai_lead_qualify`, collection `call_transcripts`. The document carries `transcript`, `muted_transcript`, the full `lead_record`, `sip_info`, timings, `turn_count`, `avg_response_latency_ms`, per-call `voice_name` and `nfe_step`, and the flags analysis depends on: `greeting_done`, `user_speech_ms`, `wrong_opener_detected`, `gemini_connect_failed`. It is inserted with **`tagged: false`**. A compound index on `(tagged, created_at)` is created at worker startup.

**Steps in execution.**

1. **Insert** — One document at call end, always <code>tagged: false</code>.
2. **Claim** — The worker finds untagged docs, oldest first.
3. **Enrich** — The analysis block is written back before any callback is attempted.
4. **Tag** — <code>tagged: true</code> only once the callback has been accepted.

**Questions.**

- **Q-D1** There is no lease or claim marker — only `tagged`. Two worker instances would analyse the same document twice. Is single-instance an enforced deployment constraint or an assumption?
- **Q-D2** Documents skipped for `no_lead_id` or `fallback_lead_id` are tagged with a `skipped_reason` and never revisited. Is anyone reading that field?

#### W · Callback worker

**In one line.** A patient loop that wakes every minute, reads the calls nobody has read yet, and decides what each one was worth.

**What it does.** Everything commercially meaningful about a call is decided here, minutes after the caller hung up: whether they were interested, whether they answered enough to count, how big the deal might be. The bot only listens; this is what judges.

**How it's built.** `callback_worker/worker.py`. Polls every `POLL_INTERVAL_SEC=60` for up to `BATCH_LIMIT=50` untagged documents and processes them one at a time. Blocking pymongo calls are pushed through `run_in_executor`. SIGTERM and SIGINT set a stop event so the **current batch finishes before exit**. On analysis failure it falls back to `fallback_analysis(status)` rather than losing the document; on callback failure it leaves the document untagged to retry next tick.

**Steps in execution.**

1. **Tick** — Find <code>{tagged: false}</code>, limit 50.
2. **Guard** — Skip and permanently tag docs with no <code>lead_id</code> or a <code>fallback_</code> one.
3. **Analyse** — <code>generate_call_analysis()</code> with the transcript, the muted transcript, duration, greeting flag, speech-ms, and the buyer's business/city/lead-bank flags.
4. **Score, or skip** — B2B scoring runs only if the outcome is not in <code>B2B_SCORE_SKIP_OUTCOMES</code>.
5. **Persist first** — Write the analysis block to the document *before* attempting the callback, so a retry never re-pays the LLM.
6. **Send** — Build and post the callback; tag the document only on success.

**Questions.**

- **Q-W1** Documents are processed strictly sequentially inside a tick. At 50 docs and two LLM calls each, how long is a worst-case tick, and does it ever exceed the 60s poll interval?
- ~~**Q-W2** Why is B2B scoring sequential rather than gathered in parallel with the analysis?~~ ✓ Because the skip decision depends on the outcome the analysis produces — gathering them would pay for scores that are thrown away (cost cut, 2026-07-22).
- **Q-W3** A permanently-failing callback keeps a document untagged forever and it is retried every minute indefinitely. Should there be an attempt count?

#### N · Disposition rubric

**In one line.** A twenty-outcome vocabulary for what a phone call can mean, and the rules for telling them apart.

**What it does.** The hard part is not summarising the call — it is drawing lines. Someone who said "hello" and hung up is a different outcome from someone who said they are not interested, which is different again from someone who wants the product but will source it themselves. Most of this file exists to keep those lines from blurring, and much of it never reaches the model at all: whole classes of call are decided deterministically before any LLM is asked.

**How it's built.** `callback_worker/analysis.py`, 3,411 lines and effectively two functions. `DISPOSITION_MAP` holds 20 outcomes with a prose definition each — the distinction between `Approved`, `Enriched` and `Interested` turns entirely on how many specification questions got a genuine on-topic reply, where **an honest "not sure" counts as answered**. Deterministic short-circuits come first: `gemini_connect_failed` → Technical Issue; empty transcript → Short Hangup. `_BARE_CALL_SIGNAL_TOKENS` is a large NFC-normalised set of phone-answering reflexes ("हेलो", "haan bolo", "ठीक है", "ओम") — if every word the caller said is in that set, the call is a Short Hangup without asking the model. Text is normalised by Unicode category (L/M/N) rather than `\w`, because `\w` strips Devanagari vowel marks and turns हेलो into हल.

**Steps in execution.**

1. **Short-circuit** — Connection failure, empty transcript, or nothing but call-answering reflexes — decided without an LLM.
2. **Classify** — One Gemini call against the 20-entry rubric, returning outcome, summary, business fields, and per-question answers.
3. **Extract Q&A** — Answers are matched back onto the original English schema question IDs.
4. **Score B2B** — <code>generate_b2b_score</code> runs a 10-point rubric: requirement intent (0–5), clarity (0–3.5), and urgency — but only for outcomes where a deal value means anything.

**Questions.**

- **Q-N1** Two functions across 3.4k lines, mostly prompt text. Is the rubric prompt versioned anywhere against outcome-quality measurements?
- **Q-N2** The bare-signal token set is hand-curated across five scripts and several regional greetings. What is the process when a new false Short Hangup is spotted?
- ~~**Q-N3** Why normalise by Unicode category instead of `\w`?~~ ✓ Devanagari vowels are combining marks (category Mn) and `\w` drops them, corrupting every match — the fix keeps categories L, M and N (recorded in the function docstring).

#### C · City mapper

**In one line.** Matches whatever city the buyer said onto the marketplace's fixed list — without ever overwriting what they actually said.

**What it does.** Buyers say city names in Hindi, in English, misspelled, or name a town that is not on the list at all. Downstream systems need one of a fixed set of names. So the raw answer and the tidy answer are kept as two separate fields, permanently — you can always see what the person really said.

**How it's built.** `callback_worker/city_mapper.py` against `data/city_list.json`. An exact or close variant maps to that entry; a city absent from the list maps to the **geographically closest** entry. `up_usr_city` is never altered; `mapped_city` is an additional field. Both travel in the callback payload.

**Steps in execution.**

1. **Collect** — The bot records whatever the buyer said as <code>up_usr_city</code>.
2. **Match** — LLM-match against the fixed list.
3. **Fall back** — Not on the list → nearest listed city.
4. **Emit** — Both fields go to MIS, side by side.

**Questions.**

- **Q-C1** A geographic-nearest fallback can produce a confidently wrong city for an unlisted town. Is `mapped_city` ever shown to a seller as if it were confirmed?

#### B · Callback payload

**In one line.** Folds the whole call down into one flat record MIS can act on — and quietly repairs what speech-to-text mangled.

**What it does.** This is the last chance to fix a call. If speech recognition dropped a digit and turned "140 GSM" into "40 GSM", it is corrected here by matching against the options the question actually offered. If a buyer gave a bare number where a quantity was wanted, a unit is attached — unless they quoted a rupee value, in which case attaching "units" would misreport money as a count.

**How it's built.** `callback_worker/callback.py::build_callback_payload`. `fuzzy_match_opt_id` patches null `opt_id`s. Quantity answers get a unit appended only when the answer is a bare number with no unit word at all — currency answers (`_CURRENCY_RE`) and any answer already carrying a real unit are left alone. At most **four `spec_ques_N` slots**: three ordinary questions plus one quantity, and for lead-bank-1 leads the confirmed city takes slot one. A call marked `disconnected` that analysis resolved as Approved or Enriched is upgraded to `completed`. Everything is stamped `ai_partner: "ai-partner-bot"`.

**Steps in execution.**

1. **Repair** — Fuzzy-match missing option IDs against the schema options.
2. **Unit-fix** — Append a unit only to a bare number, never to a currency amount.
3. **Rank** — Pick at most four spec slots, quantity guaranteed one of them.
4. **Lead a city** — For LB1 leads, prepend the confirmed city as <code>spec_ques_1</code>.
5. **Post** — <code>send_callback</code> to <code>/leads/ai-lead-qualify/callback</code>; success is what tags the document.

**Questions.**

- **Q-B1** Only four spec slots survive. Which questions get dropped when a category asks six, and does anyone see what was lost?
- ~~**Q-B2** Why upgrade `disconnected` to `completed` on a positive outcome?~~ ✓ Because the buyer did qualify before the line dropped — reporting it as a disconnect would lose a real lead (inline note in `callback.py`).

### Watching it

#### O · Audit scripts

**In one line.** A small set of hand-run scripts for the question "did we judge these calls correctly?"

**What it does.** The analysis step is a model reading a transcript, so it can drift. These scripts exist to catch that: re-score a day's calls several times and see whether the answer holds, pull the ones where the stored verdict disagrees with what MIS has, or dump a single call's logs and transcript side by side to work out what went wrong.

**How it's built.** `audit_outcome_drift.py` paginates MIS for a date, joins to Mongo by `lead_id`, re-runs `generate_call_analysis` N times, takes a **majority vote**, and flags disagreements — strictly read-only, no callbacks, no writes. `fetch_anomalies_debug.py` dumps mismatches to JSON for hand analysis. `check_outcomes_today.py` lists the day's positive outcomes. `fetch_lead_debug.py` pulls logs plus transcript for named lead IDs. `reprocess_callbacks.py` is the one that writes: a one-off corrective re-analysis and re-send.

**Steps in execution.**

1. **Pull** — Every MIS lead for a date, connected and not.
2. **Join** — Match to the Mongo transcript by <code>lead_id</code>.
3. **Re-score** — Re-run analysis N times; majority vote is the new answer.
4. **Flag** — Old outcome ≠ new outcome → anomaly row in the CSV.
5. **Correct** — Separately and deliberately, <code>reprocess_callbacks.py</code> re-sends fixed verdicts.

**Questions.**

- **Q-O1** These are all run by hand. Should drift auditing be a scheduled job with an alert threshold?
- **Q-O2** `fetch_lead_debug.py` carries a hard-coded `LEAD_IDS` list as its default — a leftover from a specific investigation?

### Wired but not live today (designed for, not built)

#### G · Gemini Live bot _(not switched on)_

**In one line.** The speech-to-speech architecture — one model doing hearing, thinking and speaking at once. Runnable today, but not what production runs.

**What it does.** The original design: no separate transcription or voice step, just a model that listens and talks. It is still fully wired and one line of YAML away, and it remains the library the live pipeline imports nearly all its business logic from — so it is not dead code in any sense, just not the voice on the line right now.

**How it's built.** `bot.py`, 4,660 lines — the largest file and the shared foundation. Gemini Live via `livekit.plugins.google.realtime.RealtimeModel`. It owns the pool of Gemini keys with inflight-aware selection and 409 quarantine, the deterministic transliteration cache, the Hindi number-to-words conversion, `build_system_prompt`, and every detection helper the pipeline imports. Its known constraint: the realtime model **cannot `generate_reply()` or update instructions mid-session**, so greetings, nudges and timeout lines are pre-composed strings.

**Steps in execution.**

1. **Select a key** — Least-inflight, round-robin among ties, skipping any in 409 cooldown.
2. **Connect** — Realtime websocket session; a failure here is recorded as <code>gemini_connect_failed</code> and becomes a Technical Issue outcome.
3. **Speak** — Pre-composed localized strings only — the model cannot be re-instructed mid-call.
4. **Save** — The same Mongo document shape as the pipeline, so the callback worker cannot tell them apart.

**Questions.**

- **Q-G1** The live pipeline imports ~25 symbols from `bot.py`, including private ones. Should the shared library be extracted so the inactive architecture is not load-bearing?
- **Q-G2** If `bot.py` is the fallback, when was `mode: gemini_live` last exercised end-to-end on the live trunk?

#### R · Standalone voice workers _(not switched on)_

**In one line.** Three near-identical per-voice workers kept runnable under their own agent names, as an escape hatch from the dispatcher.

**What it does.** Before the dispatcher existed, each voice was its own file and its own process. Those files are still here and still start, so if the dispatcher itself were the problem you could pin traffic to one known voice in a moment. The cost is that the same two and a half thousand lines exist four times over.

**How it's built.** `bot_anushka.py`, `bot_niharika.py`, `bot_simran.py` with `start_*.sh` each. Measured against each other they differ by **23–24 lines** — the voice configuration and nothing else; against `bot_pipeline.py`, 724. `bot_dev.py` is a genuine fork of `bot.py` (5,652 lines differ) carrying the hot-lead location-confirm and PIN-code flow, marked on its Mongo documents as `hotlead_pincode_flow_enabled` so analysis can tell dev calls from live ones.

**Steps in execution.**

1. **Start** — <code>./start_anushka.sh</code> — own port, own agent name.
2. **Diverge** — Any fix to the pipeline has to be copied into three files, or it silently is not.

**Questions.**

- **Q-R1** The three persona files differ from each other by ~24 lines. Now that `voice_profiles.py` exists, is there a reason to keep them rather than script the dispatcher with a pinned profile?
- **Q-R2** A pipeline fix landing in `bot_pipeline.py` does not reach the three fallbacks. How would anyone notice the drift before the fallback is needed?

## Flows (representative packets)

Payload shapes are what the design implies, not measured traffic.

### One qualification call

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | TEL → MAIN | call answered | `{"room":"jd__9876543210_a41f","metadata":{"lead_id":"LD-88213","assistant_id":"jd-hi-1"}}` |
| 2 | MAIN → YAML | read the switch | `{"path":"bot_mode.yaml"}` |
| 3 | YAML → MAIN | mode + weights | `{"mode":"own_voice","own_voice_weights":{"anushka":40,"niharika":40,"simran":20},"nfe_step_weights":{"8":100}}` |
| 4 | MAIN → VP | weighted pick | `{"drew":"niharika","nfe_step":8}` |
| 5 | VP → PIPE | voice profile | `{"voice_name":"marketplace-niharika","engine":"indic","tts_transliterate":true}` |
| 6 | PIPE → MIS | fetch lead | `{"lead_id":"LD-88213"}` |
| 7 | MIS → PIPE | lead + questions | `{"catname":"Packaging Machines","questions":3,"buyer_city":"Rajkot","lead_bank":1}` |
| 8 | PIPE → TTS | greeting | `{"text":"हेलो, मैं निहारिका बोल रही हूँ मार्केटप्लेस से।"}` |
| 9 | STT → PIPE | caller said | `{"text":"हाँ जी, बोलिए","voiced_ms":1240}` |
| 10 | PIPE → LLM | turn | `{"turn":3,"temperature":0.4}` |
| 11 | LLM → PIPE | reply | `{"text":"जी, एक सेकंड — आपको कितनी quantity चाहिए?"}` |
| 12 | PIPE → MONGO | save transcript | `{"tagged":false,"voice_name":"marketplace-niharika","nfe_step":8,"call_duration_sec":96.4,"turn_count":11}` |

### Reading the call back

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | CBW → MONGO | claim untagged | `{"filter":{"tagged":false},"limit":50}` |
| 2 | MONGO → CBW | one call | `{"_id":"66c1…","lead_id":"LD-88213","turns":11}` |
| 3 | CBW → AN | analyse | `{"greeting_done":true,"user_speech_ms":8210,"duration_secs":96.4}` |
| 4 | AN → LLM | rubric call | `{"outcomes":20,"model":"gemini-3.1-flash-lite"}` |
| 5 | LLM → AN | classified | `{"call_outcome":"Enriched","answered":2,"of":3}` |
| 6 | AN → CITY | map city | `{"up_usr_city":"राजकोट"}` |
| 7 | CITY → AN | mapped | `{"mapped_city":"Rajkot"}` |
| 8 | AN → CBW | analysis | `{"call_outcome":"Enriched","lead_intent_score":6.5,"deal_value":"2-5 lakh"}` |
| 9 | CBW → MONGO | persist analysis first | `{"set":"analysis"}` |
| 10 | CBW → CB | build payload | `{"spec_slots":4}` |
| 11 | CB → MIS | callback | `{"lead_id":"LD-88213","call_outcome":"Enriched","ai_partner":"ai-partner-bot","voice_name":"marketplace-niharika"}` |
| 12 | CBW → MONGO | tag done | `{"tagged":true}` |

### Changing the voice, live

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | YAML → MAIN | next call reads the edit | `{"own_voice_weights":{"anushka":40,"niharika":40,"simran":20}}` |
| 2 | MAIN → VP | new draw | `{"drew":"anushka"}` |
| 3 | VP → PIPE | different voice, same call flow | `{"voice_name":"marketplace-anushka"}` |
| 4 | PIPE → MONGO | recorded for scoring | `{"voice_name":"marketplace-anushka"}` |

### Auditing our own judgement

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | OPS → MIS | all leads for a date | `{"date":"2026-08-23","paginated":true}` |
| 2 | OPS → MONGO | join by lead_id | `{"matched":"connected calls only"}` |
| 3 | OPS → AN | re-score N times | `{"runs":3,"vote":"majority"}` |
| 4 | AN → OPS | new outcome | `{"old":"Could Not Confirm","new":"Enriched","changed":true}` |

## Questions — index

Reference by ID. ✓ resolved (with date) · otherwise open.

- ~~**Q-M1**~~ (M) ✓ `load_mode_config()` catches OSError/YAMLError, logs a warning and falls back to `own_voice` with the default 50/25/25 weights — calls never fail on a bad edit (2026-08-24).
- **Q-M2** (M) Nothing validates that `num_idle_processes=3` is still the right pool size for current call volume — is it?
- ~~**Q-Y1**~~ (Y) ✓ Because `bot_dev.py` had no reader at all and hard-coded Simran, so dev kept ignoring the weights. One shared module keeps both entrypoints honest (recorded in the module docstring).
- **Q-Y2** (Y) Simran keeps 20% of traffic while her 69.5% Short Hangup rate is investigated — is that investigation still open, and where is it tracked?
- **Q-Y3** (Y) The weight history lives only in YAML comments. If someone reformats the file, the experiment log is gone — should it move somewhere durable?
- ~~**Q-P1**~~ (P) ✓ A generated opener was measured as sometimes wrong; a fixed `session.say()` makes `wrong_opener_detected` structurally impossible, which is why the pipeline hard-codes it to `False` in the Mongo doc.
- **Q-P2** (P) The `[LLM-WATCHDOG]` cancel/re-inject cycles stack into 10–20s of dead air. `nfe_step=8` was verified *not* to fix it. What does?
- **Q-P3** (P) Nine watchdog cancel/re-schedule sites touch `_bot_resp_watchdog_task`. Is there a single place that owns its lifecycle, or is that invariant only held by convention?
- **Q-P4** (P) The entrypoint is one ~2,400-line function with `# noqa: C901`. Which of its seventeen sections could become testable units without changing behaviour?
- **Q-V1** (V) Three voices are already differentiated in production. Is anyone scoring the `voice_name` field on a schedule, or is it read ad hoc?
- ~~**Q-V2**~~ (V) ✓ Pre-transliteration only covers company, product and option names from the API. Ordinary Hinglish the LLM invents mid-sentence still needs the standing rule (2026-08-24).
- ~~**Q-T1**~~ (T) ✓ No — it lives on the LiveKit server, outside this branch. The repo only assumes the dispatch rule exists (2026-08-24).
- **Q-S1** (S) The muted-window path builds a fresh `aiohttp.ClientSession` per transcription rather than reusing the shared one — deliberate, or drift?
- **Q-L1** (L) Key rotation and 409 cooldown live only in `bot.py` (the Gemini Live path). The live pipeline uses a single `GEMINI_API_KEY` — does it need the same protection at current volume?
- **Q-L2** (L) The "start every reply with a 2–4 word acknowledgement" rule buys perceived latency. Has anyone measured whether it also costs a turn of quality?
- **Q-F1** (F) How often does the suppression fallback actually fire, and is it counted anywhere?
- **Q-F2** (F) The server address is a bare LAN IP with no health check in the bot. What does a call do if the box is down when the greeting is due?
- ~~**Q-A1**~~ (A) ✓ By design — the BUSINESS GATE adds product confirmation, business name and city on top of the schema questions (noted inline in `bot_pipeline.py`).
- **Q-A2** (A) `MIS_API_BASE` is a hard-coded LAN IP that `bot_pipeline.py` re-declares after importing it from `bot.py` — is the dev/live override still intentional?
- **Q-D1** (D) There is no lease or claim marker — only `tagged`. Two worker instances would analyse the same document twice. Is single-instance an enforced deployment constraint or an assumption?
- **Q-D2** (D) Documents skipped for `no_lead_id` or `fallback_lead_id` are tagged with a `skipped_reason` and never revisited. Is anyone reading that field?
- **Q-W1** (W) Documents are processed strictly sequentially inside a tick. At 50 docs and two LLM calls each, how long is a worst-case tick, and does it ever exceed the 60s poll interval?
- ~~**Q-W2**~~ (W) ✓ Because the skip decision depends on the outcome the analysis produces — gathering them would pay for scores that are thrown away (cost cut, 2026-07-22).
- **Q-W3** (W) A permanently-failing callback keeps a document untagged forever and it is retried every minute indefinitely. Should there be an attempt count?
- **Q-N1** (N) Two functions across 3.4k lines, mostly prompt text. Is the rubric prompt versioned anywhere against outcome-quality measurements?
- **Q-N2** (N) The bare-signal token set is hand-curated across five scripts and several regional greetings. What is the process when a new false Short Hangup is spotted?
- ~~**Q-N3**~~ (N) ✓ Devanagari vowels are combining marks (category Mn) and `\w` drops them, corrupting every match — the fix keeps categories L, M and N (recorded in the function docstring).
- **Q-C1** (C) A geographic-nearest fallback can produce a confidently wrong city for an unlisted town. Is `mapped_city` ever shown to a seller as if it were confirmed?
- **Q-B1** (B) Only four spec slots survive. Which questions get dropped when a category asks six, and does anyone see what was lost?
- ~~**Q-B2**~~ (B) ✓ Because the buyer did qualify before the line dropped — reporting it as a disconnect would lose a real lead (inline note in `callback.py`).
- **Q-O1** (O) These are all run by hand. Should drift auditing be a scheduled job with an alert threshold?
- **Q-O2** (O) `fetch_lead_debug.py` carries a hard-coded `LEAD_IDS` list as its default — a leftover from a specific investigation?
- **Q-G1** (G) The live pipeline imports ~25 symbols from `bot.py`, including private ones. Should the shared library be extracted so the inactive architecture is not load-bearing?
- **Q-G2** (G) If `bot.py` is the fallback, when was `mode: gemini_live` last exercised end-to-end on the live trunk?
- **Q-R1** (R) The three persona files differ from each other by ~24 lines. Now that `voice_profiles.py` exists, is there a reason to keep them rather than script the dispatcher with a pinned profile?
- **Q-R2** (R) A pipeline fix landing in `bot_pipeline.py` does not reach the three fallbacks. How would anyone notice the drift before the fallback is needed?

## What the platform gives vs what we own

**Platform gives:** LiveKit Agents gives the worker lifecycle, room join, SIP participant attributes, the `AgentSession` STT/LLM/TTS wiring, turn detection, barge-in plumbing, prewarm and idle-process pooling, and the `function_tool` decorator.

**We own:** Everything about the conversation itself: the Hindi system prompt builder, the per-call mode dispatch, the IndicF5 TTS plugin, muted-window audio capture and batch re-transcription, the response watchdogs, IVR/voicemail detection, closing-phrase and abuse detection, the whole post-call analysis rubric, and the MIS callback payload shape.

## Planned filesystem

```
bot_main.py            # live dispatcher — the worker bound to agent_name "voice-bot-marketplace"
bot_mode.yaml          # the live switch, re-read on EVERY call
bot_mode_config.py     # shared reader/picker for the yaml
bot_pipeline.py        # STT -> LLM -> TTS session (the live path)
bot.py                 # Gemini Live s2s session + the shared helper library
bot_dev.py             # dev fork of bot.py
bot_anushka|niharika|simran.py   # standalone per-voice fallback workers
voice_profiles.py      # VoiceProfile dataclass + the 4 profiles
livekit_indic5_tts.py  # IndicF5 websocket TTS plugin for LiveKit
callback_worker/
  worker.py            # 60s poll loop over untagged transcripts
  analysis.py          # disposition rubric + B2B scoring (3.4k lines)
  callback.py          # MIS callback payload builder + sender
  city_mapper.py       # freeform city -> the marketplace's fixed city list
  config.py            # Mongo / callback URLs / poll cadence
audit_outcome_drift.py # read-only outcome re-scoring audit
reprocess_callbacks.py # one-off corrective re-analysis
check_outcomes_today.py, fetch_lead_debug.py, fetch_anomalies_debug.py
```

## How this file is maintained

Generated from `atlas/data.mjs` by `node atlas/build.mjs`, which also builds the interactive atlas (`atlas.html`, published at https://claude.ai/code/artifact/d35d4ab4-dc99-4985-9bd9-5dc2da12f509). Edit the data file, rebuild, republish — never edit this file by hand.
