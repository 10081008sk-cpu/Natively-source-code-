# Natively — Architecture, UI, Audio & Vision Analysis

> Read-only analysis of the Natively Electron + React desktop application.
> No application source code was modified.
>
> Canonical sources analyzed (backups, `dist-electron/`, and generated files excluded):
> `electron/main.ts`, `electron/preload.ts`, `electron/ipcHandlers.ts`, `electron/LLMHelper.ts`,
> `electron/IntelligenceManager.ts`, `electron/IntelligenceEngine.ts`, `electron/ScreenshotHelper.ts`,
> `electron/audio/*`, `electron/llm/*`, `electron/services/screen/*`, `electron/db/DatabaseManager.ts`,
> `electron/rag/*`, `src/components/NativelyInterface.tsx`, `src/lib/overlayAppearance.ts`,
> `src/lib/meetingInterfaceTheme.ts`.

---

# Report 1 — Full System Architecture Overview

## 1.1 Process topology

Natively is a two-process Electron app with a strict separation:

| Layer | Runs in | Responsibility |
|---|---|---|
| **Main process** (`electron/main.ts` → `AppState`) | Node/Electron main | Owns OS resources: windows, native audio devices, screen capture, STT sockets, LLM HTTP calls, SQLite, auto-update, global shortcuts |
| **Preload** (`electron/preload.ts`) | Isolated preload context | Single `contextBridge` surface: `window.electronAPI`. Every renderer capability is an explicit `ipcRenderer.invoke` or `ipcRenderer.on` wrapper |
| **Renderer** (`src/`, React 19) | Chromium sandbox | UI only: `NativelyInterface.tsx`, `Launcher.tsx`, Settings, Cropper. No Node, no fs, no API keys |
| **Native addon** (`electron/audio/*` via napi-rs) | Native Rust library | Real-time system-audio tap + microphone capture, silence suppression, resampling |
| **Worker thread** (`vectorSearchWorker.ts`) | Node worker | Off-main-thread cosine similarity when sqlite-vec is unavailable |

### Main-process module map

```
electron/main.ts (AppState — 4068 lines)
├── WindowHelper              launcher window + frameless always-on-top overlay
│   ├── SettingsWindowHelper
│   ├── ModelSelectorWindowHelper
│   └── CropperWindowHelper
├── audio/
│   ├── SystemAudioCapture    native loopback tap (interviewer channel)
│   ├── MicrophoneCapture     native mic (user channel)
│   ├── GoogleSTT / NativelyProSTT / DeepgramStreamingSTT /
│   │   OpenAIStreamingSTT / LocalWhisperSTT / RestSTT /
│   │   WebSpeechSTT / Soniox / ElevenLabs
│   └── noiseSuppressor       pre-STT DSP
├── ProcessingHelper → LLMHelper (4079 lines)
│   ├── llm/ProviderRouter, ScreenCaptureRouter, VisionPipeline
│   └── IntelligenceManager → IntelligenceEngine (1031 lines)
│                              → SessionTracker
│                              → WhatToAnswerLLM / FollowUp / Recap / Clarify
├── ScreenshotHelper          desktopCapturer + sharp stitching
├── services/screen/
│   ├── ScreenUnderstandingService   vision-first orchestrator
│   ├── VisionProviderRegistry       ordered provider list
│   ├── VisionProviderFallbackChain  first-success-wins chain
│   ├── ImageOptimizer               sharp resize/JPEG/byte-cap
│   ├── OcrProviderManager           legacy OCR (runtime disabled)
│   └── ImageHashService             perceptual dedupe
├── db/DatabaseManager        better-sqlite3 + sqlite-vec (14 migrations)
├── rag/RAGManager + VectorStore + EmbeddingPipeline
└── ipcHandlers.ts            ~4k lines of IPC surface
```

## 1.2 Boot sequence (`initializeApp`, main.ts:4197)

1. `requestSingleInstanceLock()`; duplicate launches focus the existing window.
2. `app.whenReady()`; macOS `app.dock.hide()` before any window creation (stealth).
3. Load settings (`SettingsManager`), disguise payload (`process.title = "RuntimeBroker"`), credentials (`CredentialsManager.init()`).
4. Instantiate `AppState` singleton → constructs `WindowHelper`, `ScreenshotHelper`, `ProcessingHelper`, `RAGManager`, `KnowledgeOrchestrator`.
5. `initializeIpcHandlers(appState)` registers every channel **before** the renderer can call it.
6. `appState.prewarmSttProviders()` — constructs STT objects, sockets stay lazy.
7. `appState.createWindow()`, `registerAIHandlers()`, `KeybindManager.registerGlobalShortcuts()`.
8. `appState.initializeRAGManager()` opens `userData/natively.db`, loads sqlite-vec, starts embedding queue.

## 1.3 End-to-end data flow

### A. Audio → transcript → streamed answer

```
┌─────────────── MAIN PROCESS ─────────────────────────────────────────────┐
│                                                                          │
│  SystemAudioCapture ─┐   (Rust loopback tap, ~20 ms i16 chunks @48 kHz)   │
│  (interviewer)       ├─► wireSystemCapture / wireMicCapture              │
│  MicrophoneCapture ──┘        │                                          │
│  (user)                       ├─ noiseSuppressor (optional)              │
│                               ├─ zero-fill / 8 s no-data watchdogs       │
│                               └─ per-channel STT.write(chunk)            │
│                                        │                                 │
│                                        ▼                                 │
│                        GoogleSTT / NativelyProSTT / Deepgram / ...       │
│                                        │ 'transcript' {text,isFinal,conf}│
│                                        ▼                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ intelligenceManager.handleTranscript({speaker,text,timestamp,final})│ │
│  │        ▼                                                            │ │
│  │ IntelligenceEngine → SessionTracker (rolling transcript, epochs)    │ │
│  │        ├─ detectRefinementIntent()                                  │ │
│  │        ├─ PlannerDecision ("answer" | "silent" | other intent)      │ │
│  │        └─ WhatToAnswerLLM.generateStream(context, screenContext)    │ │
│  │                 │ token stream                                      │ │
│  └─────────────────┼───────────────────────────────────────────────────┘ │
│                    ▼                                                     │
│  broadcast/webContents.send:                                             │
│   • 'native-audio-transcript'        → launcher + overlay (live caption)  │
│   • 'intelligence-suggested-answer-token' → overlay (streaming bubble)    │
│   • 'intelligence-suggested-answer'  → final answer + history             │
│                                                                          │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ contextBridge / ipcRenderer.on
                                   ▼
┌─────────────────────── RENDERER (NativelyInterface.tsx) ─────────────────┐
│ queueToken(intent, token) → rAF coalescer → setMessages(prev => ...)     │
│ MessageRow (React.memo) → ReactMarkdown + Prism → animated shell         │
└──────────────────────────────────────────────────────────────────────────┘
```

Key point: **audio never crosses IPC**. Only compressed transcript events do. STT sockets, sample-rate handling, and recovery all stay in main.

### B. Screenshot / vision → answer

```
Renderer (camera button / Ctrl+Shift+Enter)
   └─ electronAPI.captureAndProcessScreenshot()  ── invoke ──┐
                                                             ▼
Main: ipcHandlers "capture-and-process-screenshot"
   └─ AppState.takeScreenshot() → ScreenshotHelper
        ├─ desktopCapturer.getSources(types:['screen'])
        ├─ source selected by display_id, logical thumbnailSize
        ├─ crop rect × scaleFactor (retina-safe)
        ├─ multi-display selection → sharp stitch → PNG
        ├─ write userData/screenshots/<uuid>.png
        └─ queue capped at MAX_SCREENSHOTS = 5 (oldest unlinked)
   └─ getImagePreview() → data:image/png;base64 (renderer thumb only)

Renderer receives {path, preview} → attaches to turn
   └─ electronAPI.generateWhatToSay(question, [path])
        └─ ipcHandlers "generate-what-to-say"
             ├─ validate paths against userData (path traversal guard)
             ├─ sendVisionStatus('analyzing'/'vision'/'classified')
             ├─ ScreenUnderstandingService.understand({imagePaths, mode})
             │     ├─ perceptual hash → 5-min cache
             │     ├─ buildVisionProviders() ordered by mode
             │     └─ runVisionFallback()
             │           ├─ ImageOptimizer.optimize(profile, provider)
             │           │    resize long edge 1024–1920, JPEG/WebP q78–90,
             │           │    strip EXIF, hard cap 3.5 MB, cache by hash
             │           ├─ try provider 1 → timeout → provider 2 → ...
             │           └─ first non-empty output wins
             ├─ structured screenContext (type, summary, OCR text)
             └─ IntelligenceManager.runWhatShouldISay(..., screenContext)
                  └─ LLMHelper.streamChat → tokens → renderer
```

### C. Manual chat path (streaming)

```
Renderer input → electronAPI.streamGeminiChat(message, imagePaths, context)
   → IPC invoke "gemini-chat-stream"
      → LLMHelper.streamChat(...)          (async generator)
          → _streamChatInner → provider selection
      → for await (token) sender.send('gemini-stream-token', token)
      → sender.send('gemini-stream-done' | 'gemini-stream-error')
   → renderer onGeminiStreamToken → queueToken → rAF flush → UI
```

A monotonic `_chatStreamId` guards the stream: a newer request increments it and any older loop bails before emitting, preventing interleaved tokens (`ipcHandlers.ts:417-535`).

## 1.4 IPC surface (representative)

| Direction | Channel | Purpose |
|---|---|---|
| invoke | `capture-and-process-screenshot` | Capture + return path/preview |
| invoke | `take-selective-screenshot` | Cropper region |
| invoke | `generate-what-to-say` | Vision + answer pipeline |
| invoke | `generate-code-hint`, `generate-brainstorm` | Vision-first coding modes |
| invoke | `gemini-chat-stream` | Streaming manual chat |
| invoke | `submit-manual-question` | Non-streaming intelligence answer |
| invoke | `start-meeting` / `end-meeting` | Session lifecycle |
| invoke | `get-screenshots`, `delete-screenshot` | Queue management |
| invoke | `modes:*`, `settings:*`, `license:*` | Configuration |
| push | `native-audio-transcript` | Live transcript caption |
| push | `intelligence-suggested-answer-token` | Auto-answer stream |
| push | `stt-status` | connected / reconnecting / failed |
| push | `audio-capture-failed` | Watchdog banners |
| push | `vision-analysis-status` | Vision progress chip |
| push | `gemini-stream-token` / `-done` / `-error` | Chat stream |
| push | `screenshot-taken`, `capture-and-process` | Screenshot shortcuts |
| push | `global-shortcut` | Stealth hotkeys |

## 1.5 Persistence and RAG

- **DB file**: `app.getPath('userData')/natively.db`.
- **Engine**: `better-sqlite3`, WAL mode, `sqlite-vec` extension loaded with an asar path fix.
- **Schema**: `meetings`, `transcripts`, `ai_interactions`, `chunks`, `chunk_summaries`, `embedding_queue`, `user_profile`, `resume_nodes`, `modes`, `mode_reference_files`, `mode_note_sections`, `profile_custom_notes`, `app_state`.
- **Migrations**: `PRAGMA user_version` 1→14. v3–v9 create per-dimension `vec_chunks_<dim>` / `vec_summaries_<dim>` `vec0` virtual tables; v4 dropped strict 768-dim tables to allow flexible embedding sizes.
- **Dual write**: embedding stored in the legacy `BLOB` column **and** the dimension-specific `vec0` table.
- **Search**: native sqlite-vec ANN first, with a worker-thread JS cosine fallback (`VectorStore.searchSimilar`).
- **Live RAG**: final transcript segments are fed to `RAGManager.feedLiveTranscript()` and JIT-indexed during a meeting.
- **Embeddings**: cascaded pipeline OpenAI → Gemini → Ollama → bundled local model.

## 1.6 Architectural observations

**Strengths**
- Hard process boundary is respected; renderer has no direct filesystem/network access.
- Audio and vision are fully isolated subsystems with typed event contracts.
- Every long-running path has a watchdog or failure reason surfaced to the UI.
- Streaming is generator-based end-to-end, with explicit cancellation.

**Risks / rough edges**
- `main.ts`, `ipcHandlers.ts`, `LLMHelper.ts`, and `NativelyInterface.tsx` are each ~4k lines — high coupling and merge-conflict risk.
- Two answer pipelines coexist (automatic `IntelligenceManager` vs manual `gemini-chat-stream`), so history can diverge if sync logic regresses.
- Provider capability logic is spread across `ProviderRouter`, `VisionProviderRegistry`, and `modelCapabilities`, which makes precedence hard to reason about.
- Legacy OCR service remains present but runtime-disabled; dead code raises future re-introduction risk (explicitly warned in-file).

---

# Report 2 — UI & Component Hierarchy (`NativelyInterface.tsx`)

## 2.1 File anatomy (4089 lines)

| Lines | Section |
|---|---|
| 1–70 | Imports, Framer Motion, Prism, Markdown plugins, theme/glass imports |
| 72–90 | `sanitizeInput`, `stripSystemInstructions` |
| 92–134 | `Message` and `NativelyInterfaceProps` types |
| 136–155 | `SCREENSHOT_ANALYSIS_MODES`, `DSA_LANGUAGES`, Prism custom style |
| 167–202 | `HighlightedCode` (memoized) |
| 220–326 | `MessageRow` (memoized) |
| 328–4439 | Main `NativelyInterface` component |

## 2.2 Component hierarchy

```
NativelyInterface
├── <div ref=contentRef data-interface-theme="liquid-glass?">
│   └── <AnimatePresence>
│       └── {isExpanded && <motion.div  opacity/y/scale>}
│           ├── Header row (drag region)
│           │   ├── <WindowControls />            minimize / close controls
│           │   └── <TopPill />                   logo, Hide, Stop, Quit
│           ├── Mode/audio/vision status strip
│           │   ├── Mode pill
│           │   ├── STT pill (Mic)
│           │   ├── Vision pill (Monitor) — provider/model/failure reason
│           │   └── Privacy pill (ShieldCheck)
│           ├── <DynamicActionBar />              Cluely-style live action cards
│           ├── <RollingTranscript />             live caption + per-channel STT health
│           ├── <motion.div ref=shellRef>         the glass shell
│           │   ├── <GlassEffectLayer />          only when liquid-glass
│           │   └── <motion.div ref=scrollContainerRef>
│           │       ├── Thread tabs: Meeting Chat | Screenshot Analysis
│           │       ├── Screenshot thread
│           │       │   └── MessageRow[] (screenshotMessages)
│           │       └── Chat thread
│           │           └── MessageRow[] (messages)
│           │               └── renderMessageText
│           │                   ├── ReactMarkdown + remarkGfm/math + rehypeKatex
│           │                   ├── <HighlightedCode />  (Prism)
│           │                   └── <NegotiationCoachingCard />
│           └── Input area
│               ├── Attachment tray (previews, remove-all)
│               ├── Analysis-mode selector (Auto/Code Review/DSA/General/Error)
│               ├── DSA language select
│               ├── Stealth hotkey / permission banners
│               ├── <input> + Enter/Ctrl+Enter handling
│               ├── Model selector button (opens detached window)
│               ├── Settings button
│               └── Send (ArrowRight)
└── ErrorBoundary wrappers around chat and input
```

## 2.3 Sub-components and responsibilities

| Component | Location | Responsibility |
|---|---|---|
| `NativelyInterface` | :328 | Root orchestrator: state, IPC subscriptions, shortcuts, layout, composition |
| `HighlightedCode` | :167 | Memoized single fenced block. Prism highlighting, language header, `wrapLongLines:false`, horizontal scroll |
| `MessageRow` | :261 | Memoized message bubble. Role alignment, intent-themed card chrome, copy button, streaming/final rendering |
| `TopPill` | `./ui/TopPill` | Drag handle pill: logo → launcher, Hide, Stop, Quit |
| `WindowControls` | `./WindowControls` | OS window buttons, drag-region aware |
| `RollingTranscript` | `./ui/RollingTranscript` | Live interviewer caption + mic/system STT status + diagnostics copy |
| `GlassEffectLayer` | `./ui/GlassEffectLayer` | Renders the `liquid-glass-react` displacement/refraction layer over the shell |
| `DynamicActionBar` | `./dynamic-actions/DynamicActionBar` | Renders auto-detected action cards, dispatches prompt to `handleWhatToSay` |
| `NegotiationCoachingCard` | `../premium` | Premium negotiation-coaching payload card |
| `ErrorBoundary` | `./ErrorBoundary` | Isolates chat and input crashes |
| Status pills | inline | Mode, STT, Vision, Privacy; tone classes (`ok`/`warn`) |
| Attachment tray | inline | Screenshot thumbnails, per-item and clear-all removal |
| Analysis mode selector | inline | Maps `auto|code-review|dsa|general|error` to prompt instructions |
| Model selector button | inline | Opens detached `ModelSelectorWindow` above button |
| Settings button | inline | Opens detached settings window above button |

Helper functions: `sanitizeInput` (strips control/zero-width chars), `stripSystemInstructions` (prevents prompt leakage in rendered text).

## 2.4 State model

| State | Purpose |
|---|---|
| `messages` | Meeting Chat thread |
| `screenshotMessages` | Screenshot Analysis thread |
| `activeThread: 'chat' \| 'screenshot'` | Which thread renders; also routes streaming tokens |
| `isExpanded` | Overlay shell visible vs. pill-only |
| `isProcessing` + `isProcessingRef` | Prevents double-submit; ref gives synchronous guard |
| `inputValue`, `attachedContext`, `screenshotAnalysisMode`, `dsaLanguage` | Composer |
| `sttUser*`, `sttInterviewer*` | Per-channel STT status/provider/error |
| `visionStatus`, `latestVision*` | Vision progress, provider, model, failure reason |
| `overlayOpacity`, `interfaceTheme`, `isLightTheme` | Appearance |
| Refs: `scrollContainerRef`, `shellRef`, `contentRef`, `codeExpandedRef`, `pendingCaptureRef`, `isScreenshotAnalysisRef` | Layout/stream stability |

## 2.5 Framer Motion and the overlay shell

**Entrance/exit** (`:3591-3597`):

```tsx
<AnimatePresence>
  {isExpanded && (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.95 }}
      transition={{ duration: 0.3, ease: "easeInOut" }}
    />
  )}
</AnimatePresence>
```

**Width animation** is deliberately *not* a CSS width transition and *not* an OS window resize:

- Constants: `SHELL_WIDTH_COLLAPSED = 600`, `SHELL_WIDTH_EXPANDED = 780`, `STABLE_OVERLAY_WIDTH = 780`.
- `shellWidth = useMotionValue(600)` is bound to the shell's inline `width`.
- Changing width uses imperative `animate(shellWidth, target, { type:'tween', ease:[0.65,0,0.35,1], duration:0.7 })`.
- `scrollMaxH = useTransform(shellWidth, [600,780], [320,560])` makes the scroll viewport grow with the shell.
- The OS window is pinned to 780 while expanded, centered with `mx-auto`. The extra 90 px per side is transparent gutter, so the TopPill's screen position never moves and no IPC resize occurs during the animation.
- `ResizeObserver` reports height-only changes, rAF-debounced, so the window tracks vertical growth without fighting the CSS spring.
- Stick-to-bottom: on each animation tick, if the user was at the bottom (`distanceFromBottom <= 8`), `scrollTop` is re-pinned in the same frame.

**Why this design**: avoids the classic "IPC resize race" where renderer animation and `setBounds` fight, causing clipping or horizontal jumps. It is renderer-only animation against a stable canvas.

## 2.6 Adaptive width expansion for code blocks

1. Each message containing code renders a wrapper with `data-code-msg`.
2. `checkCodeVisibility()` scans those nodes each scroll frame and after every `messages` update.
3. A visibility change must persist for `STABILITY_MS = 120 ms` before committing (debounces scroll-edge flicker that would interrupt the 0.7 s tween).
4. If any code block is visible → expand to 780; otherwise collapse to 600.
5. `codeExpandedRef` tracks the committed state; `startTransition` wraps the width change so React can keep the UI responsive.
6. Code has `wrapLongLines: false` and a horizontally scrollable body, so line layout stays stable as width animates.
7. While streaming, code fences can appear mid-stream, so the same check runs on every message update via `requestAnimationFrame`.

Result: the canvas "breathes" open when a code answer enters the viewport and contracts when it leaves.

## 2.7 Thread switching: Meeting Chat vs. Screenshot Analysis

- Two independent arrays: `messages` (transcripts/Q&A) and `screenshotMessages` (vision).
- Tabs call `setActiveThread('chat' | 'screenshot')`.
- **Screenshot attach** (`handleScreenshotAttach`, `capture-and-process` listener) immediately:
  - sets `activeThread = 'screenshot'`
  - sets `isScreenshotAnalysisRef.current = true` *before* state commits — this works around React batching so the same tick's stream lands in the right array
  - stores the path in `pendingCaptureRef` for the next send
- **Token routing**: streaming callbacks check `isScreenshotAnalysisRef` / `activeThread` and dispatch to `setScreenshotMessages` or `setMessages`.
- **Context selection**: screenshot thread sends `screenshotMessages` as context and, if no new image is attached, reuses the most recent `hasScreenshot` message's path.
- Each thread has its own placeholder message and `isStreaming` flag, so stopping one does not corrupt the other.
- Switching tabs never clears either thread; both persist for the meeting.

## 2.8 Theme tokens and the visual system

Three appearance modes, resolved in one `useMemo` (`:629`):

| Mode | Source | Implementation |
|---|---|---|
| **Standard dark** | `useResolvedTheme() === 'dark'` and `interfaceTheme === 'default'` | `getOverlayAppearance(opacity, 'dark')` returns inline styles |
| **Standard light** | resolved theme `light` | `getOverlayAppearance(opacity, 'light')` returns inline styles |
| **Liquid glass** | `interfaceTheme === 'liquid-glass'` | `getGlassOverlayAppearance()` returns empty styles; CSS `[data-interface-theme="liquid-glass"]` rules + `<GlassEffectLayer>` do the work |

`overlayAppearance.ts` exposes a full token set, each derived from opacity:

```
shellStyle, pillStyle, transcriptStyle, subtleStyle, chipStyle,
inputStyle, controlStyle, iconStyle, codeBlockStyle,
codeHeaderStyle, dividerStyle
```

- Opacity is normalized over `0.35 … 1.0`.
- `surfaceStrength = strength^1.02`, `blurStrength = strength^0.94`.
- Light mode: blue-tinted white surfaces (`rgba(248,251,255,…)`), `saturate(145%)`, 4–18 px blur.
- Dark mode: neutral slate (`rgba(24,26,32,…)`), `saturate(140%)`, 6–20 px blur.
- Liquid glass: `getGlassOverlayAppearance()` is intentionally all-empty; CSS variables and `GlassEffectLayer` (displacement map, corner radius 24) handle refraction, borders, and highlights.
- `meetingInterfaceTheme.ts` persists the choice in `localStorage` and dispatches a synthetic `storage` event so the overlay repaints immediately.
- Theme is applied via `data-interface-theme` on the root, so CSS selectors can override tokens without touching TSX.

Additional design tokens used throughout: semantic Tailwind classes (`overlay-text-primary`, `overlay-text-muted`, `overlay-icon-surface`, `overlay-input-surface`, `overlay-code-block-surface`) plus a Prism theme switch (`oneLight` vs `vscDarkPlus`).

## 2.9 Performance patterns worth noting

- `MessageRow` and `HighlightedCode` are `React.memo` with hand-written comparators, so streaming one row does not re-render history.
- `remarkPlugins`/`rehypePlugins` are module-scope constants; `mdComponents` is memoized per intent — avoids defeating ReactMarkdown's internal bailout.
- Tokens are rAF-coalesced (`queueToken`/`flushToken`), capping state updates at frame rate.
- Layout reads are batched once per frame; scroll writes are single assignments.
- Screenshot/STT listeners that must survive expansion are mounted in mount-only effects, not in the `[isExpanded]` effect.
- `will-change: width` was deliberately removed because it created a stale compositor layer across meeting remounts.

---

# Report 3 — Deep Dive: Audio & Vision Pipelines

## 3.1 Audio capture: two completely separate channels

Natively runs **two independent capture objects feeding two independent STT instances**. They never mix.

| Aspect | System / interviewer | Microphone / user |
|---|---|---|
| Wrapper | `electron/audio/SystemAudioCapture.ts` | `electron/audio/MicrophoneCapture.ts` |
| Native module | `RustAudioCapture` (napi-rs) | `RustMicCapture` (napi-rs) |
| Init strategy | **Lazy** — native monitor created in `start()` to avoid a 1 s audio mute at app launch | **Eager** — monitor created in constructor and kept alive across stop/restart to avoid re-init latency |
| Platform mechanism | CoreAudio Process Tap / ScreenCaptureKit on macOS; WASAPI loopback on Windows | CPAL input stream from selected microphone |
| Event contract | `data`, `start`, `stop`, `error`, `sample_rate_changed`, `speech_ended` | `data`, `start`, `stop`, `error`, `speech_ended` |
| Chunk format | linear16 PCM, ~20 ms per chunk (~960 samples @48 kHz) | same |
| STT instance | `this.googleSTT` | `this.googleSTT_User` |
| Renderer speaker tag | `interviewer` | `user` |
| Noise suppression | `_sysNoiseSuppressor` | `_micNoiseSuppressor` |
| Permission gate | macOS Screen Recording TCC | macOS Microphone TCC |
| Typical failure mode | Screen Recording denied, route mismatch, same input/output device, zero-filled TCC buffers | device contention, muted input, hot-unplug |

### Wiring (`setupSystemAudioPipeline`, main.ts:1670)

1. macOS fast-fail: if `getMacScreenCaptureStatus() === 'denied'`, skip `SystemAudioCapture` entirely and broadcast `system-audio-permission-denied`; the meeting continues mic-only.
2. Create `SystemAudioCapture` (lazy) and `MicrophoneCapture` (eager), wire each to its own `wire*Capture`.
3. Create both STT providers via `createSTTProvider('interviewer' | 'user')`; each failure is caught independently and broadcast as terminal `audio-capture-failed`.
4. Sample rate is **not** pre-set. It is applied on the first arriving chunk, because the native monitor hasn't published the real rate until after `start()` (macOS can take 5–7 s). `sample_rate_changed` updates the STT mid-session, and `NativelyProSTT` deliberately reconnects the socket when the rate changes mid-stream.
5. `prewarmSttProviders()` constructs JS objects at launch; sockets still open lazily to avoid burning quota.

### Chunk path (`wireSystemCapture` / `wireMicCapture`)

```
capture.on('data', chunk)
  ├─ inter-chunk gap logging (>2 s, <8 s → transient route change)
  ├─ first-chunk STT rate lock
  ├─ TCC zero-fill detector (stride-sampled peak; latched off on real audio)
  ├─ noise suppressor (optional)
  └─ stt.write(chunk)
```

Both `wire*Capture` install:
- **8 s no-chunk watchdog** → `audio-capture-failed` with `stuck: true`.
- **12 s zero-fill detector** (system channel) → TCC-specific banner.
- Mic also has a zero-fill detector with a message pointing at macOS mic permission / mute / exclusive mode.
- `same input/output device` detection: macOS cannot tap a device that is also the active mic, so this is reported explicitly.

### Transcript fan-out (`createSTTProvider`, main.ts:1197)

```
stt.on('transcript', segment):
  ├─ ignore unless isMeetingActive || _isDraining
  ├─ intelligenceManager.handleTranscript({speaker,text,timestamp,final,confidence})
  ├─ if final && ragManager → ragManager.feedLiveTranscript([...])
  ├─ send 'native-audio-transcript' to launcher + overlay
  └─ if final && speaker === 'interviewer' → knowledgeOrchestrator.feedInterviewerUtterance
```

`_isDraining` is the 250 ms grace window after Stop so the final sentence is not dropped while the UI already shows "meeting ended".

## 3.2 STT reconnect logic

There are two distinct policies.

### A. `NativelyProSTT` — indefinite, resilient (default premium path)

- Exponential backoff with a **cap on the exponent**, not on attempts:
  `delay = BASE * 2^min(attempt, 6)`, plus ±20 % jitter to avoid thunder-herd.
- **Never gives up.** After `RECONNECT_WARN_AFTER` attempts it emits `persistent-reconnect`, which `main.ts` maps to a sustained `stt-status` "reconnecting" banner with an attempt count.
- `intentionalClose = true` suppresses auto-reconnect for deliberate closures:
  - sample-rate change
  - language change
  - settings reconfiguration
- `closeUpstream()` strips all JS listeners before `close()` so queued libuv events cannot mutate state of a dying socket.
- **Fatal server errors** (auth/quota) stop reconnection entirely instead of hammering the auth backend.
- Backoff is only reset after **5 s of stable connection**, avoiding a tight reconnect storm when the server accepts then immediately drops.
- On `language_detected`, the socket reconnects to apply the new language and the counter is reset.
- Buffer overflow emits `buffer-overflow` rather than growing without bound.

### B. `DeepgramStreamingSTT` — bounded exponential

- `RECONNECT_BASE_DELAY_MS * 2^attempts`, capped at `RECONNECT_MAX_DELAY_MS`.
- Stops after `RECONNECT_MAX_ATTEMPTS` and emits a terminal error.
- `code === 1000` normal close does **not** trigger reconnect.
- `keepAlive()` every 8 s prevents Deepgram's idle timeout.
- On reconnect it **discards buffered audio** — replaying seconds-old audio causes EPIPE storms.
- Buffered audio during initial connect is flushed on `Open`; buffer capped at 500 chunks.
- Backoff reset after 5 s of stable connection.

### C. Supervision in `main.ts`

- Consecutive errors increment a counter; any successful final transcript resets it.
- Broadcasts `stt-status {state: connected|reconnecting|failed, error, provider, reconnectAttempts}` per speaker.
- gRPC code 11 / "Audio Timeout Error" is downgraded to a lazy-reconnect log line.
- `persistent-reconnect` from NativelyProSTT is surfaced as a sustained warning.
- Recovery handlers (`setupAudioRecoveryHandler`, `setupMicRecoveryHandler`) restart the native capture on device errors, with capped attempts.
- After macOS sleep/wake, `restartCapturesAfterResume()` rebuilds captures because CoreAudio aggregate-device handles are invalidated.

### D. Other providers

`OpenAIStreamingSTT`, `LocalWhisperSTT`, `RestSTT`, `GoogleSTT`, `Soniox`, `WebSpeechSTT` each implement the same `STTProvider` contract (`start`, `stop`, `write`, `finalize`, `setSampleRate`, `setRecognitionLanguage`) with provider-specific reconnect or retry behavior. `LocalWhisperSTT` is local and does not need network reconnect; REST providers retry per request.

## 3.3 Vision pipeline

### Stage 1 — `ScreenshotHelper`: capture and buffer preparation

File: `electron/ScreenshotHelper.ts` (756 lines).

**Single-display capture** (`captureWithDesktopCapturer`):
1. `assertScreenRecordingPermission()` — fails fast on `denied`/`restricted`/`not-determined`.
2. Select target display: explicit preferred display → display containing the selection → primary.
3. `desktopCapturer.getSources({ types:['screen'], thumbnailSize: displayBounds })`.
   - Uses **logical** resolution, not `w × scaleFactor`. Electron already returns native-density thumbnails; requesting a larger size only adds 50–200 ms of blocking decode with no quality gain.
4. Match source by `display_id`; fall back to the first source.
5. Crop with `area × scaleFactor` for retina correctness, clamp to image bounds.
6. `fs.promises.writeFile(outputPath, image.toPNG())`.

**Multi-display selection** (`captureStitchedDesktopArea`):
- `getDisplaysIntersectingSelection(area)` captures each intersecting display.
- `stitchImages()` uses **sharp**: resize each capture to the target scale, composite onto a virtual canvas at the selection's global coordinates, output PNG.
- This is the only place `ScreenshotHelper` itself touches buffers with sharp.

**Queueing**:
- `screenshotQueue` (queue view) and `extraScreenshotQueue` (solutions view).
- `MAX_SCREENSHOTS = 5`; oldest file is unlinked when exceeded.
- `takeSelectiveScreenshot()` routes to stitched capture if the selection spans displays, otherwise single-display crop; Linux uses `gnome-screenshot`/`scrot`/`import`.
- `getImagePreview()` retries up to 20 × 250 ms until the file exists and has non-zero size, then returns `data:image/png;base64,…` for **renderer display only**.
- `deleteScreenshot()` is path-guarded to `userData`.

**Important boundary**: `ScreenshotHelper` produces a full-resolution PNG. It does **not** compress for the LLM. Provider-sized payloads are produced later by `ImageOptimizer`.

### Stage 2 — validation and orchestration: `ScreenUnderstandingService`

File: `electron/services/screen/ScreenUnderstandingService.ts`.

```
understand(request)
 ├─ if providerPolicy.allowScreenshots === false → 'scope_blocked'
 ├─ resolve imagePaths (optionally capture if missing)
 ├─ validateImagePath() against userData (traversal guard)
 ├─ perceptual hash (ImageHashService) → 5-min cache lookup
 ├─ buildVisionProviders({mode, localOnly, scopeAllowsScreenshots, ...})
 │    └─ empty → 'no_vision_provider'
 ├─ pick optimization profile (fast/balanced/technical/best)
 ├─ build system+user prompts (technical vs general)
 └─ runVisionFallback({ imagePath: latest, cacheKey: hash, mode, providers, … })
```

`VisionProviderRegistry` builds the ordered list. Typical order for `vision_first`:

1. Natively API
2. Codex CLI
3. OpenAI
4. Gemini Flash
5. Claude
6. Gemini Pro
7. Groq Scout
8. Ollama (local)
9. Custom cURL (only if multimodal **and** screenshots scope enabled)

`private_vision` keeps only local providers; `vision_only` requires a vision-capable model.

### Stage 3 — `ImageOptimizer`: provider-ready buffers

File: `electron/services/screen/ImageOptimizer.ts`.

| Profile | Long edge | Quality | Format |
|---|---|---|---|
| `fast` | 1024 px | 78 | JPEG |
| `balanced` | 1280 px | 85 | JPEG |
| `technical` | 1536 px | 88 | JPEG |
| `best` | 1920 px | 90 | JPEG |

- `sharp(sourcePath).rotate().resize({ fit:'inside', withoutEnlargement:true })`.
- Encodes JPEG (`mozjpeg`, 4:2:0), WebP, or PNG.
- Enforces a **3.5 MB hard cap** by dropping quality 10 points per retry (max 3 attempts, floor 60).
- Strips metadata by default.
- Writes to `os.tmpdir()/natively-vision-optimized/<uuid>.<ext>`.
- In-memory cache keyed by `hash|profile|provider|longEdge|format|quality`.
- `getBuffer`, `getBase64`, `getDataUrl` for providers that need in-band base64.
- `cleanup()` / `cleanupAll()` at meeting end.

### Stage 4 — `VisionProviderFallbackChain`: first success wins

File: `electron/services/screen/VisionProviderFallbackChain.ts`.

Per provider, in order:

1. `isConfigured` → else skip `not_configured`
2. `supportsVision` → else skip `no_vision`
3. `scopeAllowsScreenshots` → else skip `scope_blocked`
4. `private_vision && !isLocal` → skip `privacy_blocked`
5. Optimize the image for that provider's hint (`optimize` is done once up front, re-encoded only if the hint changes size/quality)
6. `AbortController` with per-provider timeout
7. Invoke provider; empty output is treated as `provider_error` and the chain advances
8. First non-empty output returns `{ ok:true, output, providerUsed, modelUsed }`

Failure classification: `auth_error`, `quota_exceeded`, `network`, `timeout`, `provider_error`, `invalid_payload`.

Telemetry events: `vision_attempt`, `vision_success`, `vision_fallback`, `vision_skipped`, `vision_failed` — provider/model/duration only, never image or transcript content.

Final failure reasons surfaced to UI: `no_vision_provider`, `all_vision_failed`, `privacy_blocked`, `scope_blocked`, `provider_timeout`.

### Stage 5 — dispatch to multimodal endpoints

Two dispatch paths share the same optimized files:

**A. Auto-answer / vision-first (`generate-what-to-say`)**
- `ipcHandlers.ts:2786` validates up to 5 paths.
- Calls `ScreenUnderstandingService.understand(...)`.
- Emits `vision-analysis-status`: `processing → analyzing → vision → classified → generating → complete` (or `fallback`/`error`).
- Returns `screenContextStatus`, `visionProviderUsed`, `visionModelUsed`, `visionAttempts`, `visionFailureReason`, `usedImageInput`, `detectedScreenType`.
- `IntelligenceManager.runWhatShouldISay(..., { screenContext })` feeds the structured context into `WhatToAnswerLLM`.

**B. Chat / code hint / brainstorm**
- `optimizeImagesForVision()` runs the optimizer with the `technical` profile (1536 px, q88) before the LLM call so code text stays legible.
- `LLMHelper` provider-specific multimodal generators read the file, base64-encode, and build provider-shaped payloads:
  - `streamWithOpenaiMultimodal` → `image_url` data URL
  - `streamWithClaudeMultimodal` → Anthropic image block
  - `streamWithGeminiModel` → inline data part
  - `streamWithGroqMultimodal` → OpenAI-compatible image URL
  - `streamWithNatively` → compressed base64 to the Natively API
  - `streamWithOllama` → base64 `images` array
  - `streamWithCustom` → user-defined template
- `streamWithCodexCli` passes image paths to the Codex CLI.

### Full vision data flow

```
desktopCapturer
   │ nativeImage (PNG in memory)
   ▼
ScreenshotHelper ── crop × scaleFactor ──► userData/screenshots/<uuid>.png
   │                                          │
   │ getImagePreview() → base64 PNG           │ path
   ▼                                          ▼
Renderer thumbnail                    IPC generate-what-to-say / chat
                                              │
                                              ▼
                              validateImagePath() + perceptual hash cache
                                              │
                                              ▼
                              ImageOptimizer (resize + JPEG + 3.5 MB cap)
                                              │ optimized path
                                              ▼
                              VisionProviderFallbackChain
                                 ├─ Natively → OpenAI → Gemini Flash
                                 ├─ Claude → Gemini Pro → Groq
                                 ├─ Ollama → Custom
                                 └─ per-provider AbortController timeout
                                              │
                                              ▼
                              first non-empty text + provider/model
                                              │
                                              ▼
                              IntelligenceManager / LLMHelper
                                              │ streamed tokens
                                              ▼
                              renderer → MessageRow → Markdown/Prism
```

### Status and failure reporting

- `vision-analysis-status` drives the Screenshot Analysis progress chip.
- `generate-what-to-say` returns structured status so the composer pill can show:
  - `N screen attached`
  - `Vision: <provider>`
  - `No vision provider`
  - `Vision failed`
  - `Private mode blocked vision`
  - `Screenshots disabled`
  - `Vision timed out`
- `latestVisionFailureReason` and `latestVisionProviderUsed/ModelUsed` persist after the turn for the tooltip.

## 3.4 Notable safeguards

| Area | Safeguard |
|---|---|
| Path traversal | `validateImagePath` restricts to `userData`; `getScreenshotCommand` refuses shell paths outside `userData` |
| Retina cropping | logical → device pixels via `scaleFactor` |
| Multi-monitor | display_id matching + sharp stitching |
| Provider limits | soft long-edge bounds + hard 3.5 MB cap with quality retry |
| Privacy | `private_vision` blocks all non-local providers; `scopeAllowsScreenshots` gates before path resolution |
| Cost/latency | perceptual-hash 5-min cache, optimizer cache, per-provider timeouts |
| Audio silence | 8 s no-chunk watchdog, 12 s zero-fill detector, same-device detection |
| STT storms | capped exponential backoff, jitter, 5 s stability reset, fatal-error stop |
| Stream races | monotonic `_chatStreamId`, generation IDs in `IntelligenceEngine` |
| Teardown races | JS-side post-stop guards, deferred native stop, listener strip before close |

## 3.5 Risks / technical debt observed

1. **`ScreenshotHelper.getImagePreview` is a 5 s retry loop** on the IPC path; if the OS is slow to flush, the caller blocks. Low frequency, but it is synchronous-ish latency.
2. **Two image-optimization entry points** (`ScreenUnderstandingService` chain and `optimizeImagesForVision`) use slightly different profiles; a shared policy object would reduce drift.
3. **`ImageOptimizer` caches by source path in the IPC helper** (`cacheKey: p`) rather than the perceptual hash, so the same screen re-captured to a new file is re-encoded. The vision chain does use the hash.
4. **Legacy OCR code remains** (`ScreenContextService`, `OcrProviderManager`, Tesseract) and is runtime-disabled; it is an attractive nuisance for future contributors.
5. **Reconnect policy divergence** (indefinite for Natively Pro vs bounded for Deepgram) is intentional but undocumented in a single place; operators reading logs must know which provider they are looking at.
6. **`main.ts:683` contains a commented-out `setupSystemAudioPipeline()` call**, so audio pipeline construction depends on the meeting-start path (`:2815`). That is correct today but fragile to reordering.
7. **Native module absence is only logged**, not surfaced: `SystemAudioCapture`/`MicrophoneCapture` constructors log an error and `start()` becomes a no-op if the `.node` binary is missing. The UI would show an empty transcript rather than "native audio module unavailable".

---

## Summary

- **Architecture**: Electron main owns all privileged work; preload exposes a typed `electronAPI`; React renderer only renders. Audio and screenshots enter main, become transcripts/optimized images, and leave as streamed tokens over dedicated IPC channels.
- **UI**: `NativelyInterface.tsx` is a single memoized-heavy orchestrator around `MessageRow`/`HighlightedCode`, with a stable-width shell animation (600↔780 tween), code-visibility-driven expansion, two independent threads, and three appearance modes (dark, light, liquid glass).
- **Pipelines**: system audio and mic are fully separated native captures with independent STT instances; reconnect is indefinite+jittered for Natively Pro and bounded for Deepgram; screenshots are captured/cropped/stitched as PNG, then optimized by sharp and dispatched through a first-success vision provider chain.
