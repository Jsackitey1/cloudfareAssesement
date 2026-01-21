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
- *[User Input Needed: Please describe any setup or CLI issues]*


