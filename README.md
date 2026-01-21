# Feedback Copilot

An AI-powered product feedback analysis tool built on Cloudflare's developer platform. It ingests raw user feedback, enriches it with AI analysis, scores priority using a "gravity" algorithm, and provides an intelligent chat interface for product managers to query insights.

**Live Demo:** [feedback-copilot.sackiteyjoseph44.workers.dev](https://feedback-copilot.sackiteyjoseph44.workers.dev)

---

## Features

- **AI-Powered Analysis** — Automatically categorizes feedback (Bug, UX, Feature, Other), extracts sentiment, and generates explanations using Llama 3.1
- **Gravity Scoring** — Prioritizes issues using a custom algorithm that weighs sentiment, category, and recency
- **Conversational Copilot** — Natural language interface to query feedback trends (e.g., "Show me critical bugs from the last 24 hours")
- **Issue Management** — Drill-down views with "Ask Copilot" button for AI-generated impact analysis and recommended next steps, plus the ability to close resolved issues
- **Real-time Dashboard** — Visual overview of all feedback sorted by priority with click-to-drill-down functionality

---

## Architecture

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  POST /ingest   │─────▶│    Workflow     │─────▶│   D1 Database   │
│  (Raw Feedback) │      │ (AI Enrichment) │      │  (Persistence)  │
└─────────────────┘      └─────────────────┘      └─────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Chat UI       │◀─────│  POST /chat     │◀─────│   Workers AI    │
│   Dashboard     │      │ (Intent Router) │      │  (Llama 3.1)    │
└─────────────────┘      └─────────────────┘      └─────────────────┘
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| AI | Workers AI (Llama 3.1 8B Instruct) |
| Orchestration | Cloudflare Workflows |
| Frontend | Vanilla HTML/JS with Tailwind CSS |

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/app` | Chat interface |
| `GET` | `/dashboard` | Full feedback dashboard |
| `POST` | `/ingest` | Ingest new feedback (triggers AI workflow) |
| `POST` | `/chat` | Conversational query endpoint |
| `GET` | `/issue?id=<uuid>` | Get issue details |
| `POST` | `/issue/close` | Mark issue as closed |

---

## How It Works

1. **Ingest** — Raw feedback is submitted via `/ingest` and queued in a Cloudflare Workflow
2. **Enrich** — The workflow calls Workers AI to extract sentiment, category, and a short explanation
3. **Score** — A gravity score is calculated: `(|sentiment| × 10 / age_hours)` with a 2× multiplier for bugs
4. **Store** — Enriched data is persisted to D1
5. **Query** — Users interact via a chat UI that uses AI to parse intent, query D1, and generate grounded responses

---

## Project Structure

```
cloudfareAssesement/
├── README.md                 # This file
└── feedback-copilot/
    ├── src/
    │   └── index.ts          # Worker entry point (routes, workflow, UI)
    ├── schema.sql            # D1 database schema
    ├── wrangler.toml         # Cloudflare configuration
    └── package.json
```
