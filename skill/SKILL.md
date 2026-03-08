---
name: ghostmeet
description: AI meeting assistant via ghostmeet. Start sessions, get live transcripts, and generate AI summaries from any browser meeting.
metadata:
  {
    "openclaw": {
      "emoji": "👻",
      "requires": { "anyBins": ["docker", "curl"] }
    }
  }
---

# Ghostmeet — AI Meeting Assistant

Control [ghostmeet](https://github.com/Higangssh/ghostmeet) from chat. Self-hosted meeting transcription with Whisper + AI summaries.

## Prerequisites

ghostmeet backend must be running (Docker):

```bash
# Quick start
git clone https://github.com/Higangssh/ghostmeet.git
cd ghostmeet
cp .env.example .env
# Edit .env: set GHOSTMEET_ANTHROPIC_KEY for AI summaries
docker compose up -d
```

Chrome Extension must be installed in developer mode from `extension/` folder.

Default backend: `http://127.0.0.1:8877`

## What You Can Do

- **"Summarize my last meeting"** → generate AI summary from the latest session
- **"How many meetings did I have today?"** → list all sessions
- **"What was discussed?"** → fetch full transcript
- **"Extract action items"** → pull tasks from the summary
- **"Check ghostmeet status"** → backend health check

> Note: Starting/stopping live recording is done through the Chrome Extension. This skill handles **querying and summarizing recorded sessions**.

## API Commands

### Health Check
```bash
curl -s http://127.0.0.1:8877/api/health
```
Returns: `{"status": "ok", "whisper_model": "base", "device": "cpu"}`

### List Sessions
```bash
curl -s http://127.0.0.1:8877/api/sessions
```
Returns list of all meeting sessions with IDs, start times, and segment counts.

### Get Transcript
```bash
curl -s http://127.0.0.1:8877/api/sessions/{session_id}/transcript
```
Returns full transcript with timestamps and text segments.

### Generate Summary
```bash
curl -s -X POST http://127.0.0.1:8877/api/sessions/{session_id}/summarize
```
Triggers AI summary generation (requires `GHOSTMEET_ANTHROPIC_KEY`).
Returns: key decisions, action items, and next steps.

### Get Summary
```bash
curl -s http://127.0.0.1:8877/api/sessions/{session_id}/summary
```
Returns previously generated summary.

## Workflow

### During a Meeting
1. User joins a meeting (Google Meet, Zoom, Teams) in Chrome
2. Clicks ghostmeet extension icon → side panel opens
3. Clicks "Start" → real-time transcription begins
4. Transcripts appear live in the side panel

### After a Meeting
User asks: "Summarize my last meeting"

1. List sessions → find the latest session ID
2. Get transcript → review what was discussed
3. Generate summary → extract key points
4. Deliver summary to user

### Example Interaction

User: "What was discussed in my last meeting?"
→ `curl http://127.0.0.1:8877/api/sessions` → get latest session
→ `curl http://127.0.0.1:8877/api/sessions/{id}/transcript` → get transcript
→ Summarize key points for the user

User: "Generate a summary with action items"
→ `curl -X POST http://127.0.0.1:8877/api/sessions/{id}/summarize`
→ `curl http://127.0.0.1:8877/api/sessions/{id}/summary`
→ Deliver formatted summary

User: "How many meetings did I have today?"
→ `curl http://127.0.0.1:8877/api/sessions` → count today's sessions

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GHOSTMEET_MODEL` | `base` | Whisper model (tiny/base/small/medium/large-v3) |
| `GHOSTMEET_LANGUAGE` | auto | Force language (en/ko/ja etc.) or auto-detect |
| `GHOSTMEET_CHUNK_INTERVAL` | `10` | Transcription interval in seconds |
| `GHOSTMEET_ANTHROPIC_KEY` | — | Claude API key for summaries |
| `GHOSTMEET_HOST` | `0.0.0.0` | Backend bind address |
| `GHOSTMEET_PORT` | `8877` | Backend port |

### Model Size Guide
- **tiny** (75MB): Fast, lower accuracy. Good for quick notes
- **base** (145MB): Balanced. Recommended for most users
- **small** (488MB): Better accuracy, slower
- **medium** (1.5GB): High accuracy, needs good CPU/GPU
- **large-v3** (3GB): Best accuracy, requires GPU

## Usage Guidelines

1. **Always check health first** — verify backend is running before other commands
2. **List sessions to find IDs** — session IDs are date-based (e.g., `20260308-065021`)
3. **Summarize only when asked** — summary generation costs API tokens
4. **Format transcripts nicely** — don't dump raw JSON, present as readable conversation
5. **Respect privacy** — meeting transcripts are sensitive. Never share outside the current chat
6. **If backend is down** — suggest `docker compose up -d` in the ghostmeet directory

## Troubleshooting

- **Connection refused** → Backend not running. `docker compose up -d`
- **No sessions** → No meetings recorded yet. Chrome Extension must be active during meeting
- **Summary fails** → `GHOSTMEET_ANTHROPIC_KEY` not set in `.env`
- **Poor transcription** → Try larger Whisper model or set explicit language
