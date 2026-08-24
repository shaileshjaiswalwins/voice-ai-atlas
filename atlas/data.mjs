// Single source of truth for this atlas. Everything else is generated from it.
// Build: node atlas/build.mjs → writes ../SYSTEM.md and ../atlas.html
//
// Anonymized case study of a production Hindi-language voice-AI system that
// qualified marketplace buyer leads over the phone at scale. Company name and
// internal endpoints are replaced with placeholders; the architecture, the
// decisions, and the reasoning are as they were.

export const META = {
  title: 'Voice AI Atlas',
  artifactUrl: 'https://claude.ai/code/artifact/fd2e7942-4904-4f3d-85ac-243d3c22bba1',
  sourcePath: 'atlas/data.mjs',
  buildCmd: 'node atlas/build.mjs',
  stats: [
    { k: 'Domain', v: 'Hindi voice AI · telephony' },
    { k: 'Scale', v: '~23k lines · 23 services' },
    { k: 'Live mode', v: 'own_voice' },
  ],
  intro: `_**An anonymized architecture case study.** This file is the single source of truth; the interactive atlas and this document are both generated from it. It describes a Hindi-language outbound voice-AI system that qualified marketplace buyer leads over the phone — what ran in production, and why each piece is shaped the way it is. Company name and internal endpoints have been replaced with placeholders._`,
  onePara: `A buyer posts a requirement on the marketplace. The telephony trunk rings them and drops the call into a LiveKit room; one worker process, \`bot_main.py\`, picks it up. On every single call it re-reads \`bot_mode.yaml\` from disk and decides — live, without a restart — which architecture answers: a Gemini Live speech-to-speech bot, a Sarvam-voiced pipeline, or (what production runs today) one of three self-hosted IndicF5 Hindi voices chosen by weighted random draw. The chosen bot fetches the buyer's lead from the MIS API, builds a Hindi system prompt around that lead's qualification questions, and runs a Sarvam-STT → Gemini-LLM → IndicF5-TTS loop for at most five minutes, capturing audio even while its own microphone is muted so nothing the buyer says is lost. When the call ends the transcript lands in MongoDB tagged \`tagged: false\`. A separate long-running worker polls that collection every 60 seconds, re-reads each transcript with Gemini against a twenty-entry disposition rubric, scores B2B intent, maps the stated city onto the marketplace's fixed city list, and posts the verdict back to the MIS callback API. Because every call records which voice spoke it, the weights in \`bot_mode.yaml\` are a running production A/B test.`,
  costModel: [
    'Per-call LLM spend has three parts, all Gemini 3.1 Flash Lite unless noted:',
    '',
    '| Call | When | Notes |',
    '|---|---|---|',
    '| Conversational LLM | every turn, during the call | `gemini-3.1-flash-lite`, temperature 0.4, full Hindi system prompt |',
    '| Transliteration | once per lead, up front | `gemini-3.1-flash-lite-preview`, narrow single-purpose call, cached in `_TRANSLIT_CACHE` — replaced asking the live LLM inline, which was measured at ~41–43% Latin-leak (2026-07-23/24 audit) |',
    '| Post-call analysis | once per transcript | `generate_call_analysis` against the 20-outcome `DISPOSITION_MAP` |',
    '| B2B score | once per transcript, **conditionally** | skipped entirely for the 8 outcomes in `B2B_SCORE_SKIP_OUTCOMES` — a deliberate cost cut on 2026-07-22, sequential rather than gathered so the skip decision can be made first |',
    '',
    'TTS cost is infrastructure, not per-token: IndicF5 runs on our own box at `tts.internal:8404`. Its `nfe_step` knob trades latency for quality (8 fast / 16 balanced / 32 best) and is pinned to 8 for 100% of calls since 2026-07-22.',
  ],
  deepDive: `The \`bot_mode.yaml\` comment block is itself an ongoing experiment log — it records each weight change with the metric that justified it, the z-score, and, on 2026-07-25, an explicit note that equal-weighting Anushka and Niharika was "a bigger bet than the data alone justifies". That honesty is worth preserving; it is the only place the reasoning behind the live traffic split is written down.`,
  platformGives: 'LiveKit Agents gives the worker lifecycle, room join, SIP participant attributes, the `AgentSession` STT/LLM/TTS wiring, turn detection, barge-in plumbing, prewarm and idle-process pooling, and the `function_tool` decorator.',
  weOwn: 'Everything about the conversation itself: the Hindi system prompt builder, the per-call mode dispatch, the IndicF5 TTS plugin, muted-window audio capture and batch re-transcription, the response watchdogs, IVR/voicemail detection, closing-phrase and abuse detection, the whole post-call analysis rubric, and the MIS callback payload shape.',
  filesystem: `bot_main.py            # live dispatcher — the worker bound to agent_name "voice-bot-marketplace"
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
check_outcomes_today.py, fetch_lead_debug.py, fetch_anomalies_debug.py`,
};

export const DECISIONS = [
  { axis: 'Mode switching', decision: '`bot_mode.yaml` is read fresh on every incoming call, never cached — changing architecture or voice weights takes effect on the next call with no worker restart', adr: '—' },
  { axis: 'Live architecture', decision: '`own_voice` — the Sarvam-STT → Gemini-LLM → IndicF5-TTS pipeline, not Gemini Live s2s. Gemini Live and the Sarvam voice stay wired and runnable as fallbacks', adr: '—' },
  { axis: 'Voice split', decision: 'anushka 40 / niharika 40 / simran 20, set 2026-07-25. Niharika equal-weighted with Anushka on a 4-day Enriched trend despite a much shorter track record — recorded in the yaml as a deliberate bet, not a data-driven one', adr: '—' },
  { axis: 'TTS quality knob', decision: '`nfe_step` pinned to 8 for 100% of calls (2026-07-22) to shave latency — with a verified note that this will *not* fix the 10–20s dead-air gaps, which are LLM thinking plus watchdog re-inject loops', adr: '—' },
  { axis: 'Transliteration', decision: 'Company, product and option names are transliterated to Devanagari by a narrow single-purpose LLM call before prompt build, never by the live conversational LLM (~41–43% Latin-leak measured, 2026-07-23/24)', adr: '—' },
  { axis: 'Question text', decision: 'A qualification question\'s `text` is *translated* into natural Hindi by the live LLM; only its option labels are mechanically transliterated. The original English schema is what persists to Mongo and what analysis matches against', adr: '—' },
  { axis: 'Analysis cost', decision: 'B2B scoring is skipped entirely for the 8 terminal/negative outcomes in `B2B_SCORE_SKIP_OUTCOMES`, sequentially after the outcome is known rather than gathered in parallel (2026-07-22)', adr: '—' },
  { axis: 'Durability', decision: 'Analysis is persisted to the transcript document *before* the callback is attempted, so a failed callback retries on the next tick without re-paying for the LLM', adr: '—' },
  { axis: 'City handling', decision: '`up_usr_city` keeps exactly what the buyer said, forever. `mapped_city` is a separate additional field holding the LLM\'s best match against `data/city_list.json`', adr: '—' },
];

export const GROUPS = [
  { id: 'call', title: 'The live call' },
  { id: 'ext', title: 'What the call talks to' },
  { id: 'post', title: 'After the call' },
  { id: 'ops', title: 'Watching it' },
  { id: 'off', title: 'Wired but not live today' },
];

export const NODES = [
  // ── The live call ─────────────────────────────────────────────────────────
  { id: 'TEL', code: 'T', name: 'Telephony + LiveKit room', short: 'TELEPHONY', group: 'ext', gx: 1, gy: 1, w: 2.4, d: 2.4, h: 40, kind: 'slab',
    one: 'The phone line — a SIP trunk that dials the buyer and drops the answered call into a LiveKit room.',
    what: 'When a buyer needs qualifying, the dialer places a call. The moment they pick up, the audio becomes a room that a bot can walk into. Everything the atlas shows downstream starts here.',
    how: 'A LiveKit SIP trunk with a dispatch rule bound to <code>agent_name="voice-bot-marketplace"</code>. The room name carries the buyer\'s mobile (matched out with <code>__(\\d{10,12})_</code>) and the room metadata carries <code>lead_id</code>, <code>assistant_id</code> and <code>call_id</code>. The caller\'s number and the dialed number are read afterwards from the SIP participant\'s attributes.',
    steps: [
      ['Dial', 'The outbound dialer rings the buyer.'],
      ['Answer', 'A LiveKit room is created; the SIP participant joins.'],
      ['Dispatch', 'The dispatch rule wakes the worker registered under the matching agent name.'],
      ['Attributes', 'The bot reads <code>sip.phoneNumber</code> and the dialed number off the participant once the session is up.'],
    ],
    cond: [{ q: 'Is the SIP trunk config version-controlled anywhere in this repo?', r: 'No — it lives on the LiveKit server, outside this branch. The repo only assumes the dispatch rule exists (2026-08-24).' }] },

  { id: 'MAIN', code: 'M', name: 'Dispatcher', short: 'DISPATCHER', group: 'call', gx: 5.4, gy: 1, w: 2.4, d: 2.4, h: 58, kind: 'gate',
    one: 'The single worker bound to the phone line — it decides, per call, which bot answers.',
    what: 'One process is registered with the telephony service. Rather than hard-wiring one bot to the line, it looks up the current setting the instant a call lands and hands the call to whichever architecture is configured. That is the reason the system can change its own voice mid-day.',
    how: '<code>bot_main.py</code>. Registers <code>WorkerOptions(entrypoint_fnc=dispatch_entrypoint, prewarm_fnc=bot_pipeline.prewarm_fnc, agent_name="voice-bot-marketplace", num_idle_processes=3)</code>. Its entrypoint calls <code>load_mode_config()</code> and branches: <code>gemini_live</code> → <code>bot.entrypoint(ctx)</code>; <code>sarvam</code> → <code>bot_pipeline.entrypoint(ctx, SARVAM_PROFILE)</code>; otherwise a <mark>weighted random draw</mark> over the IndicF5 voices, with a second independent draw for <code>nfe_step</code>.',
    steps: [
      ['Read the switch', 'Load <code>bot_mode.yaml</code> fresh — no caching, no restart.'],
      ['Branch on mode', 'Three architectures, one line of yaml decides.'],
      ['Draw a voice', 'On <code>own_voice</code>, <code>weighted_pick</code> over anushka/niharika/simran.'],
      ['Draw a quality step', 'A second <code>weighted_pick</code> over <code>nfe_step</code>, so latency-vs-quality is A/B tested in production too.'],
      ['Log the choice', 'One <code>[MODE]</code> line records room, mode, voice_name and nfe_step — the audit trail for the experiment.'],
      ['Hand off', 'Call the chosen entrypoint with the chosen profile.'],
    ],
    cond: [
      { q: 'What happens if the yaml is unreadable mid-call-storm?', r: '<code>load_mode_config()</code> catches OSError/YAMLError, logs a warning and falls back to <code>own_voice</code> with the default 50/25/25 weights — calls never fail on a bad edit (2026-08-24).' },
      'Nothing validates that `num_idle_processes=3` is still the right pool size for current call volume — is it?',
    ] },

  { id: 'YAML', code: 'Y', name: 'The live switch', short: 'MODE SWITCH', group: 'call', gx: 5.4, gy: -3.2, w: 2.2, d: 2.2, h: 26, kind: 'box',
    one: 'A four-line YAML file that is the whole control panel for which bot production runs.',
    what: 'Editing this file changes what the next caller hears. There is no deploy, no restart, no flag service. It also carries a written record of every weight change and the numbers that justified it — the closest thing the system has to a lab notebook.',
    how: '<code>bot_mode.yaml</code>, read by <code>bot_mode_config.load_mode_config()</code> (override the path with <code>$BOT_MODE_CONFIG</code>). Three keys: <code>mode</code> (<code>gemini_live</code> | <code>sarvam</code> | <code>own_voice</code>), <code>own_voice_weights</code>, <code>nfe_step_weights</code>. <code>_clean_weights()</code> coerces unknown or invalid entries back to defaults and falls back to the full default set if everything sums to zero. Currently <mark>anushka 40 / niharika 40 / simran 20</mark>, <code>nfe_step 8: 100</code>.',
    steps: [
      ['Edit', 'Change a number, save.'],
      ['Next call', 'The dispatcher re-reads the file — the change is live.'],
      ['Record', 'The comment block above each block explains why the number is what it is, with dates and z-scores.'],
    ],
    cond: [
      { q: 'Why extract the reader into `bot_mode_config.py` rather than leave it in `bot_main.py`?', r: 'Because `bot_dev.py` had no reader at all and hard-coded Simran, so dev kept ignoring the weights. One shared module keeps both entrypoints honest (recorded in the module docstring).' },
      'Simran keeps 20% of traffic while her 69.5% Short Hangup rate is investigated — is that investigation still open, and where is it tracked?',
      'The weight history lives only in YAML comments. If someone reformats the file, the experiment log is gone — should it move somewhere durable?',
    ] },

  { id: 'PIPE', code: 'P', name: 'Pipeline session', short: 'THE BOT', group: 'call', gx: 10, gy: 1.6, w: 3.2, d: 3.2, h: 76, kind: 'tall',
    one: 'The bot itself — a five-minute Hindi conversation stitched together from speech-to-text, a language model, and a voice.',
    what: 'This is where the call actually happens. It greets the buyer by name, works through the qualification questions the MIS API returned for their product, notices when they change what they want, notices when it has reached a machine instead of a person, notices when they are winding down, and hangs up gracefully. Most of its two and a half thousand lines are not the conversation — they are the guards around it.',
    how: '<code>bot_pipeline.py</code>, entrypoint at line 266, seventeen numbered sections. <code>AgentSession(stt, llm, tts, turn_detection="stt")</code>. Business logic is imported wholesale from <code>bot.py</code> (prompt builder, lead fetch, transcript builder, closing/abuse detection, Silero gating) so the two architectures stay behaviourally identical. Hard call cap 300s. Barge-in is suppressed for the first 4 seconds of any reply. A <mark>muted-window capture</mark> subscribes to the raw audio track directly so the caller is still recorded while the bot\'s own mic is off, then batch-transcribes that window through Sarvam and injects it.',
    steps: [
      ['1 · Pre-fetch the lead', 'Fire <code>fetch_lead()</code> before <code>ctx.connect()</code> so the MIS round-trip overlaps room join.'],
      ['2 · Resolve config', '<code>fetch_bot_config(assistant_id)</code>, falling back to <code>_HARDCODED_BOT_CONFIG</code>. Sets thresholds: silero 0.6, min speech 1000ms, inactivity 4/4/10/5s.'],
      ['4 · Build the prompt', 'Transliterate company/product/option names to Devanagari first, then <code>build_system_prompt()</code> with the persona, the LB1 city flow and the buyer-assist flow.'],
      ['5 · Wire the plugins', 'Sarvam <code>saaras:v3</code> STT → Gemini <code>3.1-flash-lite</code> → IndicF5 or Sarvam <code>bulbul:v3</code> TTS. Pre-synthesize the hold message and the noise nudge.'],
      ['7 · Function tools', '<code>FetchLead</code> and <code>FetchCategorySchema</code>, the latter guarded by a seller/manufacturer token block and cushioned by a cached "एक क्षण रुकिए" hold line.'],
      ['9 · Event handlers', '<code>user_input_transcribed</code>, <code>agent_state_changed</code>, <code>conversation_item_added</code>, <code>metrics_collected</code> — plus the response watchdogs.'],
      ['10 · Muted-window capture', 'Rolling 5s PCM buffer; frames captured while muted are wrapped as WAV and posted to Sarvam batch STT in <code>codemix</code> mode.'],
      ['13 · Greet', 'A deterministic pre-composed greeting via <code>session.say()</code> — never generated, so the opener can never come out wrong.'],
      ['14–15 · Timers', '300s hard timeout; a three-strike inactivity ladder capped by <code>_STALL_RESET_CAP = 6</code> so a noisy line cannot loop silently forever.'],
      ['Save', 'Build the transcript, compute duration and average latency, insert one document into MongoDB with <code>tagged: false</code>, delete the room.'],
    ],
    cond: [
      { q: 'Why is the greeting spoken rather than generated?', r: 'A generated opener was measured as sometimes wrong; a fixed <code>session.say()</code> makes <code>wrong_opener_detected</code> structurally impossible, which is why the pipeline hard-codes it to <code>False</code> in the Mongo doc.' },
      'The `[LLM-WATCHDOG]` cancel/re-inject cycles stack into 10–20s of dead air. `nfe_step=8` was verified *not* to fix it. What does?',
      'Nine watchdog cancel/re-schedule sites touch `_bot_resp_watchdog_task`. Is there a single place that owns its lifecycle, or is that invariant only held by convention?',
      'The entrypoint is one ~2,400-line function with `# noqa: C901`. Which of its seventeen sections could become testable units without changing behaviour?',
    ] },

  { id: 'VP', code: 'V', name: 'Voices', short: 'VOICES', group: 'call', gx: 10, gy: -3.2, w: 2.6, d: 2.6, h: 30, kind: 'cards',
    one: 'Four interchangeable personalities — one Sarvam voice and three of our own — each a small frozen record of everything that differs between them.',
    what: 'Swapping the voice used to mean swapping a whole file. Now a voice is a handful of fields: which engine speaks, which speaker name, what she calls herself, her greeting, and whether her prompt needs the extra Hindi-script coaching. Which one a caller gets is decided by the dice roll in the dispatcher, and recorded on the call so the experiment can be scored later.',
    how: '<code>voice_profiles.py</code> — a frozen <code>@dataclass VoiceProfile</code>. <code>SARVAM_PROFILE</code> reads Latin script natively and deliberately keeps <code>persona_name="Simran"</code> so the base prompt is left byte-for-byte unchanged. The three <code>INDIC_PROFILES</code> set <code>tts_transliterate=True</code> and carry <code>_TTS_CACHE_HINT</code> plus <code>_TRANSLITERATION_HINT</code>. Each also lists <code>extra_echo_markers</code> (e.g. <code>"अनुष्का बोल रही"</code>) so the bot can recognise its own voice bleeding back through the line. <code>voice_name</code> is what gets persisted for A/B scoring.',
    steps: [
      ['Pick', 'The dispatcher draws a profile from <code>INDIC_PROFILES</code>.'],
      ['Shape the prompt', '<code>extra_prompt_hints</code> are appended for IndicF5 voices only.'],
      ['Shape the audio', '<code>engine</code> selects the TTS plugin; <code>nfe_step</code> is overlaid per call via <code>dataclasses.replace</code>.'],
      ['Record', '<code>voice_name</code> is written to Mongo and forwarded in the MIS callback.'],
    ],
    cond: [
      'Three voices are already differentiated in production. Is anyone scoring the `voice_name` field on a schedule, or is it read ad hoc?',
      { q: 'Why do the IndicF5 profiles need `_TRANSLITERATION_HINT` at all if names are pre-transliterated?', r: 'Pre-transliteration only covers company, product and option names from the API. Ordinary Hinglish the LLM invents mid-sentence still needs the standing rule (2026-08-24).' },
    ] },

  // ── What the call talks to ────────────────────────────────────────────────
  { id: 'STT', code: 'S', name: 'Sarvam speech-to-text', short: 'HEARING', group: 'ext', gx: 14.6, gy: -1.4, w: 2.2, d: 2.2, h: 34, kind: 'slab',
    one: 'Turns the caller\'s Hindi into text, twice over — live during the call, and in batches for the moments the bot was talking.',
    what: 'Hearing is used in two modes. Streaming, for the ordinary back-and-forth. And in batch, for the seconds when the bot had its own microphone switched off and would otherwise have missed the caller cutting in.',
    how: '<code>sarvam.STT(language="hi-IN", model="saaras:v3", mode="transcribe", flush_signal=True)</code> for the live stream, with Sarvam owning turn detection. The muted window posts a hand-built WAV to <code>https://api.sarvam.ai/speech-to-text</code> with <code>mode=codemix</code> and a 10s timeout. Final live transcriptions are gated by Silero (<code>_silero_voiced_ms</code>, threshold 0.6, min 1000ms) against a rolling 5-second PCM window — <mark>rolling, not fill-then-drop</mark>, because the mic unmutes 4s into a 10s bot turn and a fixed buffer filled with the bot\'s own echo starved the gate.',
    steps: [
      ['Stream', 'Frames flow while the mic is enabled.'],
      ['Gate', 'A final transcription is checked against the Silero voiced-ms window before it counts as a turn.'],
      ['Buffer', 'While muted, raw frames accumulate separately.'],
      ['Batch', 'On unmute, the muted window is WAV-wrapped and transcribed, then injected as a turn.'],
    ],
    cond: ['The muted-window path builds a fresh `aiohttp.ClientSession` per transcription rather than reusing the shared one — deliberate, or drift?'] },

  { id: 'LLM', code: 'L', name: 'Gemini', short: 'THINKING', group: 'ext', gx: 14.6, gy: 2.8, w: 2.2, d: 2.2, h: 34, kind: 'slab',
    one: 'The language model that carries the conversation, transliterates names, and later reads the whole call back.',
    what: 'The same family of model does three different jobs here, deliberately kept apart: one holds the conversation, one does nothing but convert English words into Hindi script, and one reads the finished transcript and decides what the call was worth. Splitting them was a measured decision, not a stylistic one.',
    how: 'Conversation: <code>google.LLM(model="gemini-3.1-flash-lite", temperature=0.4)</code>. Transliteration: <code>gemini-3.1-flash-lite-preview</code>, a narrow single-purpose call cached in <code>_TRANSLIT_CACHE</code>. Analysis: <code>gemini-3.1-flash-lite</code> in the callback worker. The Gemini Live path additionally load-balances a key pool — <code>_next_gemini_key()</code> picks the least-inflight key, round-robins among ties, and <mark>quarantines a key for 60s on a 409</mark>, falling back to the soonest-to-recover key rather than failing the call.',
    steps: [
      ['Prompt', 'A Hindi system prompt built per lead, with per-question phrasing rules and a mandatory 2–4 word opening acknowledgement so the first TTS chunk plays in ~100ms.'],
      ['Turn', 'One generation per user turn, with watchdogs re-injecting if no response arrives.'],
      ['Tools', 'Two function tools it may call mid-conversation.'],
      ['Analyse', 'Later, offline, a separate call reads the whole transcript against the disposition rubric.'],
    ],
    cond: [
      'Key rotation and 409 cooldown live only in `bot.py` (the Gemini Live path). The live pipeline uses a single `GEMINI_API_KEY` — does it need the same protection at current volume?',
      'The "start every reply with a 2–4 word acknowledgement" rule buys perceived latency. Has anyone measured whether it also costs a turn of quality?',
    ] },

  { id: 'TTS', code: 'F', name: 'IndicF5 voice server', short: 'SPEAKING', group: 'ext', gx: 14.6, gy: 7, w: 2.2, d: 2.2, h: 34, kind: 'slab',
    one: 'Our own Hindi voice, synthesised on our own hardware over a websocket.',
    what: 'The three named voices are not a vendor product — they are fine-tuned models running on a box we own. That is why the quality-versus-speed dial is ours to turn, and why the plugin has to cope with a voice occasionally refusing to speak a line.',
    how: '<code>livekit_indic5_tts.IndicF5TTS</code>, a non-streaming <code>tts.TTS</code> talking to <code>ws://tts.internal:8404/ws</code> at 24kHz. Options carried per call: <code>nfe_step</code>, <code>speaker</code>, <code>transliterate</code>, <code>speed</code>, <code>style</code>. Some fine-tuned speakers intermittently return <code>{"event":"end","sentences":0,"suppressed":true}</code> with <mark>zero audio and no error</mark> — the plugin retries once with <code>fallback_speaker</code> so a suppressed line never becomes dead air on a live call.',
    steps: [
      ['Synthesize', 'One websocket request per utterance — this TTS does not stream.'],
      ['Detect suppression', 'Zero frames plus <code>suppressed: true</code> is a silent failure, not an error.'],
      ['Retry', 'Re-request once as <code>fallback_speaker</code> (default simran), unless that is already the speaker.'],
      ['Cache the canned lines', 'The hold message and noise nudge are pre-synthesized once and replayed from frames.'],
    ],
    cond: [
      'How often does the suppression fallback actually fire, and is it counted anywhere?',
      'The server address is a bare LAN IP with no health check in the bot. What does a call do if the box is down when the greeting is due?',
    ] },

  { id: 'MIS', code: 'A', name: 'MIS lead API', short: 'MIS API', group: 'ext', gx: 5.4, gy: 6.6, w: 2.4, d: 2.4, h: 34, kind: 'slab',
    one: 'the marketplace\'s system of record — where the buyer, their product, and the questions to ask them all come from, and where the verdict goes back.',
    what: 'The bot does not invent what to ask. Every call is shaped by a lead record fetched at the start: who the buyer is, what they searched for, and the list of specification questions their product category demands. When the call is over and analysed, the answers travel back to the same system.',
    how: '<code>http://mis-api.internal:8000</code>. Read: <code>fetch_lead(lead_id | mobile)</code> and <code>/leads/ai-lead-qualify/search</code> for a mid-call product change. Write: <code>/leads/ai-lead-qualify/callback</code> and <code>/callback-update</code>. The question set arrives as <code>results.search_result.question</code> and is stored on the lead as <code>qualification_schema["question"]</code>. Note the bot asks <mark>more than the schema lists</mark> — product confirmation, business name and city are hard-coded extra steps, by design.',
    steps: [
      ['Pre-fetch', 'Kicked off before room connect so the round-trip overlaps join.'],
      ['Log the questions', 'Every question the backend returned is logged verbatim per call.'],
      ['Re-fetch on change', '<code>FetchCategorySchema</code> swaps the whole question set mid-call when the buyer changes product.'],
      ['Callback', 'The analysed outcome is posted back after the call, with up to four `spec_ques_N` entries.'],
    ],
    cond: [
      { q: 'Why does the total number of asks exceed the backend question count?', r: 'By design — the BUSINESS GATE adds product confirmation, business name and city on top of the schema questions (noted inline in `bot_pipeline.py`).' },
      '`MIS_API_BASE` is a hard-coded LAN IP that `bot_pipeline.py` re-declares after importing it from `bot.py` — is the dev/live override still intentional?',
    ] },

  { id: 'MONGO', code: 'D', name: 'Call transcripts', short: 'TRANSCRIPTS', group: 'post', gx: 10, gy: 7.4, w: 2.8, d: 2.8, h: 26, kind: 'store',
    one: 'One document per call, and the handoff point between the bot and everything that happens afterwards.',
    what: 'The bot never talks to the analysis step directly. It writes down what happened and marks the document unread; something else picks it up later. That one flag is the entire coordination mechanism, and it is what makes a failed callback safe to retry.',
    how: '<code>mongodb://mongo.internal:27017</code>, db <code>ai_lead_qualify</code>, collection <code>call_transcripts</code>. The document carries <code>transcript</code>, <code>muted_transcript</code>, the full <code>lead_record</code>, <code>sip_info</code>, timings, <code>turn_count</code>, <code>avg_response_latency_ms</code>, per-call <code>voice_name</code> and <code>nfe_step</code>, and the flags analysis depends on: <code>greeting_done</code>, <code>user_speech_ms</code>, <code>wrong_opener_detected</code>, <code>gemini_connect_failed</code>. It is inserted with <mark><code>tagged: false</code></mark>. A compound index on <code>(tagged, created_at)</code> is created at worker startup.',
    steps: [
      ['Insert', 'One document at call end, always <code>tagged: false</code>.'],
      ['Claim', 'The worker finds untagged docs, oldest first.'],
      ['Enrich', 'The analysis block is written back before any callback is attempted.'],
      ['Tag', '<code>tagged: true</code> only once the callback has been accepted.'],
    ],
    cond: [
      'There is no lease or claim marker — only `tagged`. Two worker instances would analyse the same document twice. Is single-instance an enforced deployment constraint or an assumption?',
      'Documents skipped for `no_lead_id` or `fallback_lead_id` are tagged with a `skipped_reason` and never revisited. Is anyone reading that field?',
    ] },

  // ── After the call ────────────────────────────────────────────────────────
  { id: 'CBW', code: 'W', name: 'Callback worker', short: 'THE READER', group: 'post', gx: 5.4, gy: 11.8, w: 2.6, d: 2.6, h: 52, kind: 'job',
    one: 'A patient loop that wakes every minute, reads the calls nobody has read yet, and decides what each one was worth.',
    what: 'Everything commercially meaningful about a call is decided here, minutes after the caller hung up: whether they were interested, whether they answered enough to count, how big the deal might be. The bot only listens; this is what judges.',
    how: '<code>callback_worker/worker.py</code>. Polls every <code>POLL_INTERVAL_SEC=60</code> for up to <code>BATCH_LIMIT=50</code> untagged documents and processes them one at a time. Blocking pymongo calls are pushed through <code>run_in_executor</code>. SIGTERM and SIGINT set a stop event so the <mark>current batch finishes before exit</mark>. On analysis failure it falls back to <code>fallback_analysis(status)</code> rather than losing the document; on callback failure it leaves the document untagged to retry next tick.',
    steps: [
      ['Tick', 'Find <code>{tagged: false}</code>, limit 50.'],
      ['Guard', 'Skip and permanently tag docs with no <code>lead_id</code> or a <code>fallback_</code> one.'],
      ['Analyse', '<code>generate_call_analysis()</code> with the transcript, the muted transcript, duration, greeting flag, speech-ms, and the buyer\'s business/city/lead-bank flags.'],
      ['Score, or skip', 'B2B scoring runs only if the outcome is not in <code>B2B_SCORE_SKIP_OUTCOMES</code>.'],
      ['Persist first', 'Write the analysis block to the document *before* attempting the callback, so a retry never re-pays the LLM.'],
      ['Send', 'Build and post the callback; tag the document only on success.'],
    ],
    cond: [
      'Documents are processed strictly sequentially inside a tick. At 50 docs and two LLM calls each, how long is a worst-case tick, and does it ever exceed the 60s poll interval?',
      { q: 'Why is B2B scoring sequential rather than gathered in parallel with the analysis?', r: 'Because the skip decision depends on the outcome the analysis produces — gathering them would pay for scores that are thrown away (cost cut, 2026-07-22).' },
      'A permanently-failing callback keeps a document untagged forever and it is retried every minute indefinitely. Should there be an attempt count?',
    ] },

  { id: 'AN', code: 'N', name: 'Disposition rubric', short: 'THE RUBRIC', group: 'post', gx: 10, gy: 13, w: 2.8, d: 2.8, h: 44, kind: 'cards',
    one: 'A twenty-outcome vocabulary for what a phone call can mean, and the rules for telling them apart.',
    what: 'The hard part is not summarising the call — it is drawing lines. Someone who said "hello" and hung up is a different outcome from someone who said they are not interested, which is different again from someone who wants the product but will source it themselves. Most of this file exists to keep those lines from blurring, and much of it never reaches the model at all: whole classes of call are decided deterministically before any LLM is asked.',
    how: '<code>callback_worker/analysis.py</code>, 3,411 lines and effectively two functions. <code>DISPOSITION_MAP</code> holds 20 outcomes with a prose definition each — the distinction between <code>Approved</code>, <code>Enriched</code> and <code>Interested</code> turns entirely on how many specification questions got a genuine on-topic reply, where <mark>an honest "not sure" counts as answered</mark>. Deterministic short-circuits come first: <code>gemini_connect_failed</code> → Technical Issue; empty transcript → Short Hangup. <code>_BARE_CALL_SIGNAL_TOKENS</code> is a large NFC-normalised set of phone-answering reflexes ("हेलो", "haan bolo", "ठीक है", "ओम") — if every word the caller said is in that set, the call is a Short Hangup without asking the model. Text is normalised by Unicode category (L/M/N) rather than <code>\\w</code>, because <code>\\w</code> strips Devanagari vowel marks and turns हेलो into हल.',
    steps: [
      ['Short-circuit', 'Connection failure, empty transcript, or nothing but call-answering reflexes — decided without an LLM.'],
      ['Classify', 'One Gemini call against the 20-entry rubric, returning outcome, summary, business fields, and per-question answers.'],
      ['Extract Q&A', 'Answers are matched back onto the original English schema question IDs.'],
      ['Score B2B', '<code>generate_b2b_score</code> runs a 10-point rubric: requirement intent (0–5), clarity (0–3.5), and urgency — but only for outcomes where a deal value means anything.'],
    ],
    cond: [
      'Two functions across 3.4k lines, mostly prompt text. Is the rubric prompt versioned anywhere against outcome-quality measurements?',
      'The bare-signal token set is hand-curated across five scripts and several regional greetings. What is the process when a new false Short Hangup is spotted?',
      { q: 'Why normalise by Unicode category instead of `\\w`?', r: 'Devanagari vowels are combining marks (category Mn) and `\\w` drops them, corrupting every match — the fix keeps categories L, M and N (recorded in the function docstring).' },
    ] },

  { id: 'CITY', code: 'C', name: 'City mapper', short: 'CITY MAPPER', group: 'post', gx: 14.2, gy: 12.6, w: 2.2, d: 2.2, h: 28, kind: 'box',
    one: 'Matches whatever city the buyer said onto the marketplace\'s fixed list — without ever overwriting what they actually said.',
    what: 'Buyers say city names in Hindi, in English, misspelled, or name a town that is not on the list at all. Downstream systems need one of a fixed set of names. So the raw answer and the tidy answer are kept as two separate fields, permanently — you can always see what the person really said.',
    how: '<code>callback_worker/city_mapper.py</code> against <code>data/city_list.json</code>. An exact or close variant maps to that entry; a city absent from the list maps to the <mark>geographically closest</mark> entry. <code>up_usr_city</code> is never altered; <code>mapped_city</code> is an additional field. Both travel in the callback payload.',
    steps: [
      ['Collect', 'The bot records whatever the buyer said as <code>up_usr_city</code>.'],
      ['Match', 'LLM-match against the fixed list.'],
      ['Fall back', 'Not on the list → nearest listed city.'],
      ['Emit', 'Both fields go to MIS, side by side.'],
    ],
    cond: ['A geographic-nearest fallback can produce a confidently wrong city for an unlisted town. Is `mapped_city` ever shown to a seller as if it were confirmed?'] },

  { id: 'CB', code: 'B', name: 'Callback payload', short: 'THE VERDICT', group: 'post', gx: 1, gy: 11.8, w: 2.6, d: 2.6, h: 36, kind: 'box',
    one: 'Folds the whole call down into one flat record MIS can act on — and quietly repairs what speech-to-text mangled.',
    what: 'This is the last chance to fix a call. If speech recognition dropped a digit and turned "140 GSM" into "40 GSM", it is corrected here by matching against the options the question actually offered. If a buyer gave a bare number where a quantity was wanted, a unit is attached — unless they quoted a rupee value, in which case attaching "units" would misreport money as a count.',
    how: '<code>callback_worker/callback.py::build_callback_payload</code>. <code>fuzzy_match_opt_id</code> patches null <code>opt_id</code>s. Quantity answers get a unit appended only when the answer is a bare number with no unit word at all — currency answers (<code>_CURRENCY_RE</code>) and any answer already carrying a real unit are left alone. At most <mark>four <code>spec_ques_N</code> slots</mark>: three ordinary questions plus one quantity, and for lead-bank-1 leads the confirmed city takes slot one. A call marked <code>disconnected</code> that analysis resolved as Approved or Enriched is upgraded to <code>completed</code>. Everything is stamped <code>ai_partner: "ai-partner-bot"</code>.',
    steps: [
      ['Repair', 'Fuzzy-match missing option IDs against the schema options.'],
      ['Unit-fix', 'Append a unit only to a bare number, never to a currency amount.'],
      ['Rank', 'Pick at most four spec slots, quantity guaranteed one of them.'],
      ['Lead a city', 'For LB1 leads, prepend the confirmed city as <code>spec_ques_1</code>.'],
      ['Post', '<code>send_callback</code> to <code>/leads/ai-lead-qualify/callback</code>; success is what tags the document.'],
    ],
    cond: [
      'Only four spec slots survive. Which questions get dropped when a category asks six, and does anyone see what was lost?',
      { q: 'Why upgrade `disconnected` to `completed` on a positive outcome?', r: 'Because the buyer did qualify before the line dropped — reporting it as a disconnect would lose a real lead (inline note in `callback.py`).' },
    ] },

  // ── Watching it ───────────────────────────────────────────────────────────
  { id: 'OPS', code: 'O', name: 'Audit scripts', short: 'AUDIT', group: 'ops', gx: 1, gy: 16, w: 2.6, d: 2.6, h: 32, kind: 'job',
    one: 'A small set of hand-run scripts for the question "did we judge these calls correctly?"',
    what: 'The analysis step is a model reading a transcript, so it can drift. These scripts exist to catch that: re-score a day\'s calls several times and see whether the answer holds, pull the ones where the stored verdict disagrees with what MIS has, or dump a single call\'s logs and transcript side by side to work out what went wrong.',
    how: '<code>audit_outcome_drift.py</code> paginates MIS for a date, joins to Mongo by <code>lead_id</code>, re-runs <code>generate_call_analysis</code> N times, takes a <mark>majority vote</mark>, and flags disagreements — strictly read-only, no callbacks, no writes. <code>fetch_anomalies_debug.py</code> dumps mismatches to JSON for hand analysis. <code>check_outcomes_today.py</code> lists the day\'s positive outcomes. <code>fetch_lead_debug.py</code> pulls logs plus transcript for named lead IDs. <code>reprocess_callbacks.py</code> is the one that writes: a one-off corrective re-analysis and re-send.',
    steps: [
      ['Pull', 'Every MIS lead for a date, connected and not.'],
      ['Join', 'Match to the Mongo transcript by <code>lead_id</code>.'],
      ['Re-score', 'Re-run analysis N times; majority vote is the new answer.'],
      ['Flag', 'Old outcome ≠ new outcome → anomaly row in the CSV.'],
      ['Correct', 'Separately and deliberately, <code>reprocess_callbacks.py</code> re-sends fixed verdicts.'],
    ],
    cond: [
      'These are all run by hand. Should drift auditing be a scheduled job with an alert threshold?',
      '`fetch_lead_debug.py` carries a hard-coded `LEAD_IDS` list as its default — a leftover from a specific investigation?',
    ] },

  // ── Wired but not live today ──────────────────────────────────────────────
  { id: 'GEM', code: 'G', name: 'Gemini Live bot', short: 'GEMINI LIVE', group: 'off', ghost: true, gx: 10, gy: -7.6, w: 3, d: 3, h: 60, kind: 'tall',
    one: 'The speech-to-speech architecture — one model doing hearing, thinking and speaking at once. Runnable today, but not what production runs.',
    what: 'The original design: no separate transcription or voice step, just a model that listens and talks. It is still fully wired and one line of YAML away, and it remains the library the live pipeline imports nearly all its business logic from — so it is not dead code in any sense, just not the voice on the line right now.',
    how: '<code>bot.py</code>, 4,660 lines — the largest file and the shared foundation. Gemini Live via <code>livekit.plugins.google.realtime.RealtimeModel</code>. It owns the pool of Gemini keys with inflight-aware selection and 409 quarantine, the deterministic transliteration cache, the Hindi number-to-words conversion, <code>build_system_prompt</code>, and every detection helper the pipeline imports. Its known constraint: the realtime model <mark>cannot <code>generate_reply()</code> or update instructions mid-session</mark>, so greetings, nudges and timeout lines are pre-composed strings.',
    steps: [
      ['Select a key', 'Least-inflight, round-robin among ties, skipping any in 409 cooldown.'],
      ['Connect', 'Realtime websocket session; a failure here is recorded as <code>gemini_connect_failed</code> and becomes a Technical Issue outcome.'],
      ['Speak', 'Pre-composed localized strings only — the model cannot be re-instructed mid-call.'],
      ['Save', 'The same Mongo document shape as the pipeline, so the callback worker cannot tell them apart.'],
    ],
    cond: [
      'The live pipeline imports ~25 symbols from `bot.py`, including private ones. Should the shared library be extracted so the inactive architecture is not load-bearing?',
      'If `bot.py` is the fallback, when was `mode: gemini_live` last exercised end-to-end on the live trunk?',
    ] },

  { id: 'SOLO', code: 'R', name: 'Standalone voice workers', short: 'FALLBACKS', group: 'off', ghost: true, gx: 14.6, gy: -7.6, w: 2.4, d: 2.4, h: 30, kind: 'cards',
    one: 'Three near-identical per-voice workers kept runnable under their own agent names, as an escape hatch from the dispatcher.',
    what: 'Before the dispatcher existed, each voice was its own file and its own process. Those files are still here and still start, so if the dispatcher itself were the problem you could pin traffic to one known voice in a moment. The cost is that the same two and a half thousand lines exist four times over.',
    how: '<code>bot_anushka.py</code>, <code>bot_niharika.py</code>, <code>bot_simran.py</code> with <code>start_*.sh</code> each. Measured against each other they differ by <mark>23–24 lines</mark> — the voice configuration and nothing else; against <code>bot_pipeline.py</code>, 724. <code>bot_dev.py</code> is a genuine fork of <code>bot.py</code> (5,652 lines differ) carrying the hot-lead location-confirm and PIN-code flow, marked on its Mongo documents as <code>hotlead_pincode_flow_enabled</code> so analysis can tell dev calls from live ones.',
    steps: [
      ['Start', '<code>./start_anushka.sh</code> — own port, own agent name.'],
      ['Diverge', 'Any fix to the pipeline has to be copied into three files, or it silently is not.'],
    ],
    cond: [
      'The three persona files differ from each other by ~24 lines. Now that `voice_profiles.py` exists, is there a reason to keep them rather than script the dispatcher with a pinned profile?',
      'A pipeline fix landing in `bot_pipeline.py` does not reach the three fallbacks. How would anyone notice the drift before the fallback is needed?',
    ] },
];

export const FLOWS = [
  { id: 'call', name: 'One qualification call', hops: [
    ['TEL', 'MAIN', 'call answered', { room: 'jd__9876543210_a41f', metadata: { lead_id: 'LD-88213', assistant_id: 'jd-hi-1' } }, 'yx'],
    ['MAIN', 'YAML', 'read the switch', { path: 'bot_mode.yaml' }, 'xy'],
    ['YAML', 'MAIN', 'mode + weights', { mode: 'own_voice', own_voice_weights: { anushka: 40, niharika: 40, simran: 20 }, nfe_step_weights: { 8: 100 } }, 'yx'],
    ['MAIN', 'VP', 'weighted pick', { drew: 'niharika', nfe_step: 8 }, 'xy'],
    ['VP', 'PIPE', 'voice profile', { voice_name: 'marketplace-niharika', engine: 'indic', tts_transliterate: true }, 'yx'],
    ['PIPE', 'MIS', 'fetch lead', { lead_id: 'LD-88213' }, 'xy'],
    ['MIS', 'PIPE', 'lead + questions', { catname: 'Packaging Machines', questions: 3, buyer_city: 'Rajkot', lead_bank: 1 }, 'yx'],
    ['PIPE', 'TTS', 'greeting', { text: 'हेलो, मैं निहारिका बोल रही हूँ मार्केटप्लेस से।' }, 'xy'],
    ['STT', 'PIPE', 'caller said', { text: 'हाँ जी, बोलिए', voiced_ms: 1240 }, 'yx'],
    ['PIPE', 'LLM', 'turn', { turn: 3, temperature: 0.4 }, 'xy'],
    ['LLM', 'PIPE', 'reply', { text: 'जी, एक सेकंड — आपको कितनी quantity चाहिए?' }, 'yx'],
    ['PIPE', 'MONGO', 'save transcript', { tagged: false, voice_name: 'marketplace-niharika', nfe_step: 8, call_duration_sec: 96.4, turn_count: 11 }, 'xy'],
  ] },

  { id: 'verdict', name: 'Reading the call back', hops: [
    ['CBW', 'MONGO', 'claim untagged', { filter: { tagged: false }, limit: 50 }, 'xy'],
    ['MONGO', 'CBW', 'one call', { _id: '66c1…', lead_id: 'LD-88213', turns: 11 }, 'yx'],
    ['CBW', 'AN', 'analyse', { greeting_done: true, user_speech_ms: 8210, duration_secs: 96.4 }, 'xy'],
    ['AN', 'LLM', 'rubric call', { outcomes: 20, model: 'gemini-3.1-flash-lite' }, 'yx'],
    ['LLM', 'AN', 'classified', { call_outcome: 'Enriched', answered: 2, of: 3 }, 'xy'],
    ['AN', 'CITY', 'map city', { up_usr_city: 'राजकोट' }, 'yx'],
    ['CITY', 'AN', 'mapped', { mapped_city: 'Rajkot' }, 'xy'],
    ['AN', 'CBW', 'analysis', { call_outcome: 'Enriched', lead_intent_score: 6.5, deal_value: '2-5 lakh' }, 'yx'],
    ['CBW', 'MONGO', 'persist analysis first', { 'set': 'analysis' }, 'xy'],
    ['CBW', 'CB', 'build payload', { spec_slots: 4 }, 'yx'],
    ['CB', 'MIS', 'callback', { lead_id: 'LD-88213', call_outcome: 'Enriched', ai_partner: 'ai-partner-bot', voice_name: 'marketplace-niharika' }, 'xy'],
    ['CBW', 'MONGO', 'tag done', { tagged: true }, 'xy'],
  ] },

  { id: 'switch', name: 'Changing the voice, live', hops: [
    ['YAML', 'MAIN', 'next call reads the edit', { own_voice_weights: { anushka: 40, niharika: 40, simran: 20 } }, 'yx'],
    ['MAIN', 'VP', 'new draw', { drew: 'anushka' }, 'xy'],
    ['VP', 'PIPE', 'different voice, same call flow', { voice_name: 'marketplace-anushka' }, 'yx'],
    ['PIPE', 'MONGO', 'recorded for scoring', { voice_name: 'marketplace-anushka' }, 'xy'],
  ] },

  { id: 'audit', name: 'Auditing our own judgement', hops: [
    ['OPS', 'MIS', 'all leads for a date', { date: '2026-08-23', paginated: true }, 'xy'],
    ['OPS', 'MONGO', 'join by lead_id', { matched: 'connected calls only' }, 'yx'],
    ['OPS', 'AN', 're-score N times', { runs: 3, vote: 'majority' }, 'xy'],
    ['AN', 'OPS', 'new outcome', { old: 'Could Not Confirm', 'new': 'Enriched', changed: true }, 'yx'],
  ] },
];

export const CH = [
  { id: 'ring', title: 'A call is answered', reveal: ['TEL', 'MAIN'],
    lede: `Strip everything away and this is the system: a phone is answered, and one process decides what happens next.`,
    story: `<p>The dialer rings a buyer who posted a requirement on the marketplace. The instant they pick up, the call becomes a LiveKit room and a dispatch rule wakes exactly one worker.</p><p>That worker is not a bot. It is <mark>a decision about which bot</mark> — and it makes that decision fresh, for every single call.</p>`,
    flow: [['TEL', 'MAIN', 'call answered', { room: 'jd__9876543210_a41f', lead_id: 'LD-88213' }]] },

  { id: 'switch', title: 'The switch on the wall', reveal: ['YAML', 'VP'],
    lede: `A four-line YAML file decides which architecture — and which voice — answers the next caller.`,
    story: `<p>Most systems change behaviour by deploying. This one changes behaviour by saving a file. <code>bot_mode.yaml</code> is re-read on <mark>every incoming call</mark>, so editing a weight at 3pm changes what the 3:00:01pm caller hears.</p><p>Three voices split today's traffic 40/40/20, and each call records which one spoke it. That makes the split a live A/B test, and the comments in the YAML the lab notebook.</p>`,
    flow: [
      ['MAIN', 'YAML', 'read the switch', { path: 'bot_mode.yaml' }],
      ['YAML', 'MAIN', 'mode + weights', { mode: 'own_voice', anushka: 40, niharika: 40, simran: 20 }],
      ['MAIN', 'VP', 'weighted pick', { drew: 'niharika', nfe_step: 8 }],
    ] },

  { id: 'listen', title: 'Listening and thinking', reveal: ['PIPE', 'STT', 'LLM'],
    lede: `The bot proper: hearing turned into text, text turned into a Hindi reply.`,
    story: `<p>The live architecture is a three-stage pipeline, not a single speech-to-speech model. Sarvam transcribes, Gemini answers, and a great deal of code sits between them deciding what counts as the caller actually speaking.</p><p>The subtle part is the <mark>muted window</mark>: the bot's own microphone is off while it talks, so it subscribes to the raw audio track separately and batch-transcribes whatever the caller said over the top of it. Nothing is lost to the bot's own voice.</p>`,
    flow: [
      ['STT', 'PIPE', 'caller said', { text: 'हाँ जी, बोलिए', voiced_ms: 1240 }],
      ['PIPE', 'LLM', 'turn', { turn: 3, temperature: 0.4 }],
      ['LLM', 'PIPE', 'reply', { text: 'जी, एक सेकंड — कितनी quantity चाहिए?' }],
    ] },

  { id: 'speak', title: 'Speaking in our own voice', reveal: ['TTS'],
    lede: `The three named voices run on our own hardware, which is why the quality dial is ours to turn.`,
    story: `<p>IndicF5 synthesises over a websocket to a box on the LAN. Its <code>nfe_step</code> knob trades latency for quality and is pinned to 8 — with an honest note in the YAML that this <mark>will not fix the dead-air gaps</mark>, which were traced to LLM thinking and watchdog re-injects, not synthesis.</p><p>The voice can also silently refuse a line: zero audio frames, no error. The plugin retries once with a fallback speaker so that never becomes silence on a live call.</p>`,
    flow: [
      ['PIPE', 'TTS', 'synthesize', { text: 'जी, एक सेकंड', nfe_step: 8, speaker: 'niharika' }],
      ['TTS', 'PIPE', 'audio frames', { sample_rate: 24000, suppressed: false }],
    ] },

  { id: 'who', title: 'Knowing who is on the line', reveal: ['MIS'],
    lede: `The bot does not invent the questions — the lead record decides what this call is about.`,
    story: `<p>Before the room is even joined, a lead fetch is already in flight. It comes back with the buyer, what they searched for, and the specification questions their product category demands.</p><p>If the buyer changes their mind mid-call, <code>FetchCategorySchema</code> swaps the entire question set live — behind a cached "एक क्षण रुकिए" hold line, and behind a guard that <mark>blocks sellers pretending to be buyers</mark>.</p>`,
    flow: [
      ['PIPE', 'MIS', 'fetch lead', { lead_id: 'LD-88213' }],
      ['MIS', 'PIPE', 'lead + questions', { catname: 'Packaging Machines', questions: 3, lead_bank: 1 }],
    ] },

  { id: 'left', title: 'What the call leaves behind', reveal: ['MONGO'],
    lede: `The bot writes one document and marks it unread. That flag is the entire handoff.`,
    story: `<p>There is no queue and no message bus between the call and its analysis — just a document with <code>tagged: false</code>. Something else will pick it up within the minute.</p><p>It is a deliberately dull mechanism, and it buys the thing that matters: a failed callback simply <mark>stays unread and is retried</mark>, with no risk of losing a call.</p>`,
    flow: [['PIPE', 'MONGO', 'save transcript', { tagged: false, voice_name: 'marketplace-niharika', turn_count: 11, call_duration_sec: 96.4 }]] },

  { id: 'read', title: 'Reading the call back', reveal: ['CBW', 'AN'],
    lede: `A minute later, something reads the transcript and decides what the call was actually worth.`,
    story: `<p>Everything commercially meaningful is decided here, not during the call. Twenty possible outcomes, separated mostly by how many specification questions got a genuine reply — where <mark>an honest "not sure" counts as answered</mark>, because the buyer engaged.</p><p>Much of it never reaches a model. A caller who only said "हेलो" is a Short Hangup by lookup, decided before any LLM is asked, and B2B scoring is skipped entirely for the eight outcomes where a deal value would be meaningless.</p>`,
    flow: [
      ['CBW', 'MONGO', 'claim untagged', { limit: 50 }],
      ['MONGO', 'CBW', 'one call', { lead_id: 'LD-88213', turns: 11 }],
      ['CBW', 'AN', 'analyse', { greeting_done: true, user_speech_ms: 8210 }],
      ['AN', 'CBW', 'classified', { call_outcome: 'Enriched', answered: '2 of 3' }],
    ] },

  { id: 'verdict', title: 'Sending the verdict home', reveal: ['CITY', 'CB'],
    lede: `The last chance to repair a call before it becomes a record someone acts on.`,
    story: `<p>Speech recognition drops digits. "140 GSM" arrives as "40 GSM", so the answer is fuzzy-matched back against the options the question actually offered. A bare number gets a unit attached — unless it was a rupee amount, where "1000 units" would be a <mark>lie about money</mark>.</p><p>The city gets the same care: what the buyer said is kept forever in one field, and the tidy match against the marketplace's list lives beside it in another. The raw answer is never overwritten.</p>`,
    flow: [
      ['AN', 'CITY', 'map city', { up_usr_city: 'राजकोट' }],
      ['CITY', 'AN', 'mapped', { mapped_city: 'Rajkot' }],
      ['CB', 'MIS', 'callback', { call_outcome: 'Enriched', ai_partner: 'ai-partner-bot', spec_slots: 4 }],
    ] },

  { id: 'watch', title: 'Auditing our own judgement', reveal: ['OPS'],
    lede: `If a model decides what a call was worth, something has to check whether it keeps deciding the same way.`,
    story: `<p>The audit re-runs the analysis over a whole day of calls several times and takes a <mark>majority vote</mark>, then flags every lead where today's answer disagrees with the one already stored. It writes nothing — correcting is a separate, deliberate script.</p><p>All of it is run by hand.</p>`,
    flow: [
      ['OPS', 'MONGO', 'join a date by lead_id', { date: '2026-08-23' }],
      ['OPS', 'AN', 're-score, majority vote', { runs: 3 }],
      ['AN', 'OPS', 'disagreement', { old: 'Could Not Confirm', 'new': 'Enriched' }],
    ] },

  { id: 'off', title: 'Paths not taken today', reveal: ['GEM', 'SOLO'],
    lede: `Two architectures sit one line of YAML away — and one of them is load-bearing anyway.`,
    story: `<p><code>bot.py</code> is the speech-to-speech design: one model hearing, thinking and speaking. It is not the live path, but the live pipeline <mark>imports its business logic wholesale</mark> — the prompt builder, the detections, the transliteration cache. Inactive is not the same as unused.</p><p>The three standalone voice workers are a different kind of leftover: near-identical copies that differ from each other by about twenty lines, kept runnable as an escape hatch from the dispatcher.</p>`,
    flow: [['GEM', 'PIPE', 'shared helpers imported', { symbols: 25, includes: 'build_system_prompt, detections, transliteration' }]] },

  { id: 'all', title: 'The whole system', reveal: [],
    lede: `Everything at once, for free exploration.`,
    story: `<p>Choose which flow runs from the picker at bottom left. Hover anything to read it; click to pin it; <code>→</code> goes inside a structure to see its steps; click a moving dot to inspect what it carries.</p><p>The <mark>Open questions</mark> tab lists every question raised here by ID — the ones with answers carry the date they were settled.</p>`,
    flow: null },
];

export const HOW_HTML = `<div class="eyebrow">voice-ai-atlas · anonymized case study</div>
<h1 class="t">How it's built</h1>
<div class="sub">the shape, and what sits around it</div>

<h3 class="sec">The shape in one line</h3>
<p>One LiveKit worker, three interchangeable conversation architectures selected per call by a YAML file, and a polling worker that reads every finished call back with an LLM and reports a verdict to the marketplace's MIS.</p>

<h3 class="sec">What the platform gives us</h3>
<p>LiveKit Agents provides the worker lifecycle, room join, SIP participant attributes, the <code>AgentSession</code> STT/LLM/TTS wiring, turn detection, barge-in plumbing, prewarm and idle-process pooling, and the <code>function_tool</code> decorator.</p>

<h3 class="sec">What we own</h3>
<p>Everything about the conversation: the Hindi system prompt builder, the per-call mode dispatch, the IndicF5 websocket TTS plugin, muted-window capture and batch re-transcription, the response watchdogs, IVR and voicemail detection, closing-phrase and abuse detection, the entire twenty-outcome analysis rubric, and the MIS callback payload shape.</p>

<h3 class="sec">Scope of this atlas</h3>
<p>This covers the voice runtime only — roughly 23,000 lines of Python across 23 files: the telephony dispatcher, the three conversation architectures, and the post-call analysis worker. The wider platform it lived beside — a FastAPI backend, a React no-code bot builder, and the campaign-dialer and alert workers — is <mark>not drawn here</mark>. Company name and internal endpoints are placeholders; everything structural is as it ran.</p>

<h3 class="sec">Filesystem</h3>
<pre>bot_main.py            # live dispatcher — worker bound to agent_name "voice-bot-marketplace"
bot_mode.yaml          # the live switch, re-read on EVERY call
bot_mode_config.py     # shared reader/picker for the yaml
bot_pipeline.py        # STT -> LLM -> TTS session (the live path, 2,769 lines)
bot.py                 # Gemini Live s2s + the shared helper library (4,660 lines)
bot_dev.py             # dev fork of bot.py (hot-lead pincode flow)
bot_anushka|niharika|simran.py   # standalone per-voice fallback workers
voice_profiles.py      # VoiceProfile dataclass + the four profiles
livekit_indic5_tts.py  # IndicF5 websocket TTS plugin for LiveKit
callback_worker/
  worker.py            # 60s poll over untagged transcripts
  analysis.py          # disposition rubric + B2B scoring (3,411 lines)
  callback.py          # MIS callback payload builder + sender
  city_mapper.py       # freeform city -> the marketplace's fixed city list
  config.py            # Mongo / callback URLs / poll cadence
  data/city_list.json
audit_outcome_drift.py # read-only outcome re-scoring audit
reprocess_callbacks.py # one-off corrective re-analysis + re-send
check_outcomes_today.py, fetch_lead_debug.py, fetch_anomalies_debug.py</pre>

<h3 class="sec">Endpoints this branch assumes</h3>
<pre>MIS API        http://mis-api.internal:8000
MongoDB        mongodb://mongo.internal:27017  (ai_lead_qualify.call_transcripts)
IndicF5 TTS    ws://tts.internal:8404/ws
Sarvam STT     https://api.sarvam.ai/speech-to-text</pre>`;
