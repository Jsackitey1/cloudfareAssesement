# Cloudflare Feedback & Challenges

This document tracks challenges encountered while building the `feedback-copilot` project.

## Development Experience
- [ ] **Project Initialization**: Any issues with `npm create cloudflare`?
- [ ] **Configuration**: `wrangler.toml` complexity or documentation gaps?
- [ ] **Local Development**: `wrangler dev` behavior vs deployed worker.

## Specific Services
### D1 (Database)
- [ ] Schema management and migrations.
- [ ] Local vs Remote binding confusion.
- [ ] TypeScript typing for D1 results.

### Workers AI
- [ ] Model availability or latency.
- [ ] Response typing/streaming.

### Workflows
- [ ] Setup and debugging steps.

## Developer Tooling
- [ ] TypeScript integration errors.
- [ ] VS Code extension support.

## Specific user-reported challenges
### AI & Typescript
- **Type Safety**: The `AI` binding is typed as `any` in `src/index.ts`. It would be helpful to have strict types for `env.AI.run` inputs and outputs to match the specific model (e.g. `@cf/meta/llama-3-8b-instruct`).
- **Structured Output**: Parsing JSON from LLMs requires manual prompt engineering and regex cleaning (`jsonStr.match`). Native structured output support in Workers AI would simplify `FeedbackWorkflow`.

### Developer Experience
### Setup & CLI Challenges
- **Authentication Friction**: The `wrangler` CLI requires interactive browser login, which introduces a "human-in-the-loop" dependency that complicates fully automated setup scripts.
- **Missing Scripts**: The initial project template lacked standard `dev` and `deploy` scripts in `package.json`, causing `npm run dev` to fail immediately after generation.
- **Configuration Sync**: There was a mismatch between `wrangler.toml` bindings (`FEEDBACK_DB`) and `worker-configuration.d.ts` (`DB`), requiring manual code fixes to get types working.
- **Circular Dependency**: Creating a D1 database requires a two-step process: run `create` command -> copy ID -> paste into `wrangler.toml`. A more declarative approach would be smoother.

## Positive Cloudflare Experiences
- **Unified Ecosystem**: Binding D1 (database), Workers AI, and Workflows together in a single `wrangler.toml` feels very powerful and cohesive.
- **Local Simulation**: `wrangler dev` (local mode) provides an excellent development experience by simulating D1 and Workflows locally, allowing for fast iteration without deployment.
- **Performance**: The local development server starts instantly, making the feedback loop extremely short.



# Used Products

## 1. Cloudflare Workers
**Usage**: The core compute platform hosting the API and serving the HTML UI. `src/index.ts` handles all HTTP requests (`fetch` handler).

## 2. Workers AI
**Usage**: Powering the intelligence of the application.
- **Sentiment Analysis**: `FeedbackWorkflow` uses `@cf/meta/llama-3-8b-instruct` to analyze incoming feedback.
- **Intent Extraction**: The `/chat` endpoint uses Llama-3 to categorize user queries into structured intents (`top_issues`, `search`, etc.).
- **Grounded Answers**: The `/chat` endpoint uses Llama-3 to generate human-readable responses based on D1 query results (RAG-lite).

## 3. Cloudflare D1 (SQLite)
**Usage**: The persistence layer.
- **Schema**: A `feedback` table stores raw content, AI-generated metadata (sentiment, gravity score), and timestamps.
- **Queries**: Used for dashboard listing (`ORDER BY gravity_score DESC`) and dynamic chat queries (`WHERE content LIKE ?`).

## 4. Cloudflare Workflows
**Usage**: Asynchronous processing pipeline.
- **Ingestion**: `FeedbackWorkflow` decouples the ingestion API (`POST /ingest`) from the heavy AI processing, ensuring low latency for the API client while performing complex enrichment in the background.

## 5. Cloudflare Access
**Usage**: Zero Trust security.
- **Route Protection**: The `/app` and `/dashboard` routes are protected, checking for the `Cf-Access-Authenticated-User-Email` header to ensure only authenticated users can access internal tools.
