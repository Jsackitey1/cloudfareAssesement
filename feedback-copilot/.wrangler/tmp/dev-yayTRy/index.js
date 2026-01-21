var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { WorkflowEntrypoint } from "cloudflare:workers";
var FeedbackWorkflow = class extends WorkflowEntrypoint {
  static {
    __name(this, "FeedbackWorkflow");
  }
  async run(event, step) {
    const { content, source } = event.payload;
    const analysis = await step.do("analyze-feedback", async () => {
      const prompt = `
			Analyze this feedback and output strict JSON.
			Feedback: "${content}"
			
			Output format:
			{
				"sentiment": <number between 0 and 1, 1 is positive>,
				"gravity_score": <number 1-10, 10 is critical>,
				"category": "<string, e.g. Feature, Bug, Performance, Other>",
                "explanation": "<short explanation>"
			}
			`;
      const response = await this.env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: [{ role: "user", content: prompt }]
      });
      try {
        let jsonStr = response.response;
        const match = jsonStr.match(/\{[\s\S]*\}/);
        if (match) jsonStr = match[0];
        return JSON.parse(jsonStr);
      } catch (e) {
        return { sentiment: 0.5, gravity_score: 5, category: "Unknown", explanation: "Failed to analyze" };
      }
    });
    await step.do("store-db", async () => {
      const id = crypto.randomUUID();
      const createdAt = (/* @__PURE__ */ new Date()).toISOString();
      await this.env.FEEDBACK_DB.prepare(
        `INSERT INTO feedback (id, content, source, sentiment, gravity_score, category, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, content, source, analysis.sentiment, analysis.gravity_score, analysis.category, analysis.explanation, createdAt).run();
    });
  }
};
var src_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return Response.redirect(url.origin + "/app", 302);
    }
    if (request.method === "GET" && url.pathname === "/app") {
      return new Response(htmlUI(), {
        headers: { "Content-Type": "text/html" }
      });
    }
    if (request.method === "GET" && url.pathname === "/dashboard") {
      const { results } = await env.FEEDBACK_DB.prepare(
        `SELECT * FROM feedback ORDER BY gravity_score DESC, created_at DESC LIMIT 50`
      ).all();
      return new Response(htmlDashboard(results), {
        headers: { "Content-Type": "text/html" }
      });
    }
    if (request.method === "POST" && url.pathname === "/ingest") {
      const body = await request.json();
      const content = body.text;
      if (!content) return new Response("Missing content", { status: 400 });
      await env.INGEST_WORKFLOW.create({
        params: {
          content,
          source: body.source || "api"
        }
      });
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    if (request.method === "POST" && url.pathname === "/chat") {
      const body = await request.json();
      const query = body.query;
      const { results } = await env.FEEDBACK_DB.prepare(
        `SELECT content, category, gravity_score, explanation FROM feedback ORDER BY gravity_score DESC LIMIT 20`
      ).all();
      const context = results.map((r) => `- [${r.category}, Score ${r.gravity_score}]: ${r.content} (${r.explanation})`).join("\n");
      const systemPrompt = `You are Feedback Copilot. Answer the user query based on the feedback context provided. Verify your claims with the context.`;
      const userPrompt = `Context:
${context}

User Query: ${query}`;
      const response = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      });
      return new Response(JSON.stringify({ answer: response.response, contextUsed: results.length }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("Not Found", { status: 404 });
  }
};
function htmlUI() {
  return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Feedback Copilot</title>
		<script src="https://cdn.tailwindcss.com"><\/script>
	</head>
	<body class="bg-slate-900 text-white min-h-screen p-8">
		<div class="max-w-3xl mx-auto space-y-8">
			<header class="flex justify-between items-center">
				<h1 class="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-emerald-400">Feedback Copilot</h1>
				<a href="/dashboard" class="text-slate-400 hover:text-white underline">View Dashboard</a>
			</header>

			<!-- Ingest Section -->
			<div class="bg-slate-800 p-6 rounded-xl border border-slate-700">
				<h2 class="text-xl font-semibold mb-4">Submit Feedback</h2>
				<form id="ingestForm" class="space-y-4">
					<textarea id="feedbackText" placeholder="Describe the issue..." class="w-full bg-slate-900 border border-slate-700 rounded p-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none" rows="3"></textarea>
					<div class="flex gap-4">
						<input id="source" type="text" placeholder="Source (e.g. twitter)" class="bg-slate-900 border border-slate-700 rounded p-2 text-sm flex-1">
						<button type="submit" class="bg-blue-600 hover:bg-blue-500 px-6 py-2 rounded font-medium transition">Submit</button>
					</div>
				</form>
				<p id="ingestStatus" class="mt-2 text-sm text-green-400 hidden">Feedback queued!</p>
			</div>

			<!-- Chat Section -->
			<div class="bg-slate-800 p-6 rounded-xl border border-slate-700 h-[500px] flex flex-col">
				<h2 class="text-xl font-semibold mb-4">Ask the Copilot</h2>
				<div id="chatHistory" class="flex-1 overflow-y-auto space-y-4 mb-4 pr-2">
					<div class="flex justify-start"><div class="bg-slate-700 rounded-lg p-3 max-w-[80%] text-sm">Hello! Ask me about top issues or specific feedback categories.</div></div>
				</div>
				<form id="chatForm" class="flex gap-2">
					<input id="chatInput" type="text" placeholder="What are the top complaints?" class="flex-1 bg-slate-900 border border-slate-700 rounded p-3 text-sm focus:ring-2 focus:ring-emerald-500 outline-none">
					<button type="submit" class="bg-emerald-600 hover:bg-emerald-500 px-6 py-2 rounded font-medium transition">Send</button>
				</form>
			</div>
		</div>

		<script>
			// Ingest Logic
			document.getElementById('ingestForm').addEventListener('submit', async (e) => {
				e.preventDefault();
				const text = document.getElementById('feedbackText').value;
				const source = document.getElementById('source').value;
				if(!text) return;
				
				await fetch('/ingest', {
					method: 'POST',
					body: JSON.stringify({ text, source }), // API expects text/source in body, worker maps text->content
					headers: { 'Content-Type': 'application/json' }
				});
				
				document.getElementById('feedbackText').value = '';
				const status = document.getElementById('ingestStatus');
				status.classList.remove('hidden');
				setTimeout(() => status.classList.add('hidden'), 3000);
			});

			// Chat Logic
			const chatHistory = document.getElementById('chatHistory');
			function addMsg(text, isUser) {
				const div = document.createElement('div');
				div.className = \`flex \${isUser ? 'justify-end' : 'justify-start'}\`;
				div.innerHTML = \`<div class="\${isUser ? 'bg-blue-600' : 'bg-slate-700'} rounded-lg p-3 max-w-[80%] text-sm">\${text}</div>\`;
				chatHistory.appendChild(div);
				chatHistory.scrollTop = chatHistory.scrollHeight;
			}

			document.getElementById('chatForm').addEventListener('submit', async (e) => {
				e.preventDefault();
				const input = document.getElementById('chatInput');
				const query = input.value;
				if(!query) return;
				
				addMsg(query, true);
				input.value = '';
				
				try {
					const res = await fetch('/chat', {
						method: 'POST',
						body: JSON.stringify({ query }),
						headers: { 'Content-Type': 'application/json' }
					});
					const data = await res.json();
					addMsg(data.answer, false);
				} catch(err) {
					addMsg('Error getting response.', false);
				}
			});
		<\/script>
	</body>
	</html>
	`;
}
__name(htmlUI, "htmlUI");
function htmlDashboard(items) {
  const rows = items.map((i) => `
		<tr class="border-b border-slate-700">
			<td class="p-4 text-emerald-400 font-mono">${i.gravity_score}</td>
			<td class="p-4">${i.category}</td>
			<td class="p-4 text-slate-300">${i.content} <br><span class="text-xs text-slate-500">${i.explanation || ""}</span></td>
			<td class="p-4 text-slate-400 text-sm">${i.source}</td>
		</tr>
	`).join("");
  return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Dashboard</title>
		<script src="https://cdn.tailwindcss.com"><\/script>
	</head>
	<body class="bg-slate-900 text-white min-h-screen p-8">
		<div class="max-w-5xl mx-auto">
			<header class="flex justify-between items-center mb-8">
				<h1 class="text-3xl font-bold">Feedback Dashboard</h1>
				<a href="/app" class="text-blue-400 hover:text-blue-300 underline">Back to Copilot</a>
			</header>
			
			<div class="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
				<table class="w-full text-left">
					<thead class="bg-slate-700 text-slate-300">
						<tr>
							<th class="p-4">Gravity</th>
							<th class="p-4">Category</th>
							<th class="p-4">Feedback</th>
							<th class="p-4">Source</th>
						</tr>
					</thead>
					<tbody>
						${rows}
					</tbody>
				</table>
				${items.length === 0 ? '<div class="p-8 text-center text-slate-500">No feedback found. Ingest some data first!</div>' : ""}
			</div>
		</div>
	</body>
	</html>
	`;
}
__name(htmlDashboard, "htmlDashboard");

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-9G35Kv/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-9G35Kv/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  FeedbackWorkflow,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
