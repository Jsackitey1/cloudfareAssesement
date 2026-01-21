# Feedback Copilot Runbook

## 1. Local Development

Start the local development server:
```bash
npx wrangler dev
```

### Hit `/ingest` with curl
To submit a feedback item:
```bash
curl -X POST http://localhost:8787/ingest \
  -H "Content-Type: application/json" \
  -d '{"text": "The login page is too slow", "source": "curl_test"}'
```

### Hit `/chat` with curl
To query the feedback data:
```bash
curl -X POST http://localhost:8787/chat \
  -H "Content-Type: application/json" \
  -d '{"query": "Show me the top issues"}'
```

## 2. Deploy

Deploy the worker to Cloudflare:
```bash
npx wrangler deploy
```

## 3. D1 Verification

Verify the data in your D1 database:
```bash
npx wrangler d1 execute feedback-db --command "SELECT id, category, gravity_score, created_at FROM feedback ORDER BY gravity_score DESC LIMIT 5;"
```

---

## Troubleshooting

### JSON Parse Failures from the Model
*   **Symptom:** Logs show `SyntaxError: Unexpected token ...` or the chat returns "Error analyzing data".
*   **Cause:** The AI model (Llama-3) occasionally outputs Markdown (` ```json ... ``` `) or conversational text instead of pure JSON, despite instructions.
*   **Fix:** The code includes heuristic cleanup to strip Markdown, but it may fail on edge cases. Retry the request. If persistent, check `src/index.ts` and adjust the system prompt to be more strict.

### Missing D1 Binding Errors
*   **Symptom:** Error `No binding found for FEEDBACK_DB`.
*   **Cause:** The `wrangler.toml` file is missing the `[[d1_databases]]` configuration or the binding name does not match `FEEDBACK_DB`.
*   **Fix:** Ensure `wrangler.toml` contains:
    ```toml
    [[d1_databases]]
    binding = "FEEDBACK_DB"
    database_name = "feedback-db"
    database_id = "<YOUR_DATABASE_ID>"
    ```

### Workflow Binding Errors
*   **Symptom:** Error `env.INGEST_WORKFLOW.create is not a function` or similar.
*   **Cause:** The Workflow binding is missing or the class name doesn't match the export.
*   **Fix:** Ensure `wrangler.toml` contains:
    ```toml
    [[workflows]]
    binding = "INGEST_WORKFLOW"
    name = "feedback-workflow"
    class_name = "FeedbackWorkflow"
    ```
    And ensure `src/index.ts` exports `export class FeedbackWorkflow extends WorkflowEntrypoint ...`.
