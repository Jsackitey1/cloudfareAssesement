import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

interface Env {
	FEEDBACK_DB: D1Database;
	AI: any;
	INGEST_WORKFLOW: Workflow;
}

// -----------------------------------------------------------------------------
// Workflows: Enriches feedback with AI
// -----------------------------------------------------------------------------
type FeedbackEvent = {
	source: string;
	content: string;
	created_at?: string;
};

type AnalysisResult = {
	sentiment: number;
	category: "Bug" | "UX" | "Feature" | "Other";
	explanation: string;
};

const MESSY_SAMPLES = [
	"login completely broken fix it!!!",
	"I love the new dashboard, very clean",
	"where is the export button? cant find it",
	"app crashes when I upload large images",
	"pricing page is confusing as hell",
	"please add dark mode support",
	"api returns 500 error on tuesdays",
	"documentation link is broken",
	"best tool I've used all year",
	"loading takes forever on my phone",
	"can I invite more than 5 users?",
	"delete my account immediately"
];

export class FeedbackWorkflow extends WorkflowEntrypoint<Env, FeedbackEvent> {
	async run(event: WorkflowEvent<FeedbackEvent>, step: WorkflowStep) {
		const { content, source, created_at } = event.payload;

		// Step 1: AI Enrichment
		const analysis = await step.do('ai-enrichment', async () => {
			const systemPrompt = `You analyze raw user feedback and return STRICT JSON only.
Return exactly this schema:
{ "sentiment": number, "category": "Bug" | "UX" | "Feature" | "Other", "explanation": string }
Rules:
- Output JSON only. No markdown.
- sentiment must be between -1 and 1.
- category:
  - Bug: broken/errors/crashes/regressions/can't log in/failures
  - UX: confusing UI/slow/hard to find/friction/unclear flow
  - Feature: new capability/integration/API/export/filters
  - Other: praise/general comments/pricing with no concrete ask
- explanation: 1 sentence, max 18 words.
- If both bug and feature request appear, choose Bug.
- If mostly negative but not broken, choose UX.`;

			const response = await runAIWithRetry(this.env, '@cf/meta/llama-3-8b-instruct', {
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: content }
				]
			});

			try {
				// Heuristic cleanup if model outputs markdown code blocks
				let jsonStr = (response as any).response;
				const match = jsonStr.match(/\{[\s\S]*\}/);
				if (match) jsonStr = match[0];
				return JSON.parse(jsonStr) as AnalysisResult;
			} catch (e) {
				return { sentiment: 0, category: 'Other', explanation: 'Failed to analyze' } as AnalysisResult;
			}
		});

		// Step 2: Gravity Calculation and Persistence
		await step.do('calculate-and-store', async () => {
			// Gravity Calculation
			const now = new Date();
			const created = created_at ? new Date(created_at) : now;
			const ageHours = Math.max(1, Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60)));

			let base = Math.abs(analysis.sentiment) * 10 / ageHours;
			if (analysis.sentiment < 0 && analysis.category === 'Bug') {
				base *= 2;
			}
			const gravityScore = Math.min(50, Math.round(base * 100) / 100);

			// Persistence
			const id = crypto.randomUUID();
			await this.env.FEEDBACK_DB.prepare(
				`INSERT INTO feedback (id, content, source, sentiment, gravity_score, category, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
				.bind(id, content, source, analysis.sentiment, gravityScore, analysis.category, analysis.explanation, created.toISOString())
				.run();
		});
	}
}


// -----------------------------------------------------------------------------
// Main Worker: Router & UI
// -----------------------------------------------------------------------------
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Redirect root to /app
		if (request.method === 'GET' && url.pathname === '/') {
			return Response.redirect(url.origin + '/app', 302);
		}

		// GET /app - Chat UI
		if (request.method === 'GET' && url.pathname === '/app') {
			const auth = requireAuth(request);
			if (!auth) return new Response('Unauthorized', { status: 401 });

			const { results } = await env.FEEDBACK_DB.prepare(
				`SELECT * FROM feedback ORDER BY gravity_score DESC, created_at DESC LIMIT 5`
			).all();

			return new Response(htmlUI(results), {
				headers: { 'Content-Type': 'text/html' },
			});
		}

		// GET /dashboard - Simple List
		if (request.method === 'GET' && url.pathname === '/dashboard') {
			const auth = requireAuth(request);
			if (!auth) return new Response('Unauthorized', { status: 401 });

			const { results } = await env.FEEDBACK_DB.prepare(
				`SELECT * FROM feedback ORDER BY gravity_score DESC, created_at DESC LIMIT 10`
			).all();
			return new Response(htmlDashboard(results), {
				headers: { 'Content-Type': 'text/html' },
			});
		}

		// POST /ingest - Trigger Workflow
		if (request.method === 'POST' && url.pathname === '/ingest') {
			let content = '';
			let source = 'api';

			try {
				const body = await request.json() as { text: string; source: string };
				if (body.text) {
					content = body.text;
					source = body.source || 'api';
				}
			} catch (e) {
				// Ignore JSON parse errors, fall through to random sample
			}

			if (!content) {
				// Pick a random messy sample
				content = MESSY_SAMPLES[Math.floor(Math.random() * MESSY_SAMPLES.length)];
				source = 'random-generator';
			}

			await env.INGEST_WORKFLOW.create({
				params: {
					content,
					source,
					created_at: new Date().toISOString()
				}
			});

			return new Response(JSON.stringify({ ok: true, started: true }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// POST /chat - RAG-lite
		if (request.method === 'POST' && url.pathname === '/chat') {
			try {
				const auth = requireAuth(request);
				if (!auth) return new Response('Unauthorized', { status: 401 });

				const body = await request.json() as { query: string };
				const query = body.query;

				// Step 1: Intent Extraction
				const intentPrompt = `You are an intent router for a Product Feedback Copilot.
Your only job is to read the user's message and output a SINGLE valid JSON object that matches the schema below exactly. Do not include any other text.
Schema:
{
  "intent": "top_issues" | "bugs_recent" | "search" | "summary" | "issue_drilldown" | "help",
  "params": { "hours": number, "days": number, "term": string, "id": string }
}
Rules:
- Always output JSON only. No markdown, no explanations.
- Use only the intents listed. If request does not match, use "help".
- params must include ALL keys: hours, days, term, id.
- If not applicable: hours=0, days=0, term="", id="".
- Interpret time phrases:
  - today => hours=24
  - last day/past day/yesterday => hours=24
  - last 6 hours => hours=6
  - this week/last week/past week => days=7
- Prefer hours if both mentioned, unless the user explicitly wants a weekly summary.
- Map intent:
  - top_issues: highest priority/highest pull/most urgent
  - bugs_recent: bugs/breakages in recent window (default 24h if unspecified)
  - search: keyword mentions (extract term)
  - summary: trend summary (default days=7)
  - issue_drilldown: specific issue id (extract id)
  - help: capabilities/ambiguous
- If user says show me everything: top_issues.`;

				const intentResp = await runAIWithRetry(env, '@cf/meta/llama-3-8b-instruct', {
					messages: [
						{ role: 'system', content: intentPrompt },
						{ role: 'user', content: query }
					]
				});

				let intentData = { intent: 'help', params: { hours: 0, days: 0, term: '', id: '' } };
				try {
					let jsonStr = (intentResp as any).response;
					const match = jsonStr.match(/\{[\s\S]*\}/);
					if (match) jsonStr = match[0];
					intentData = JSON.parse(jsonStr);
				} catch (e) {
					// strict default
					console.error("Intent parsing failed:", e);
				}

				// Step 2: D1 Querying
				let results: any[] = [];
				const { intent, params } = intentData;

				if (intent === 'top_issues') {
					const res = await env.FEEDBACK_DB.prepare(`SELECT * FROM feedback ORDER BY gravity_score DESC, created_at DESC LIMIT 10`).all();
					results = res.results;
				} else if (intent === 'bugs_recent') {
					const hours = params.hours || 24;
					const date = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
					const res = await env.FEEDBACK_DB.prepare(`SELECT * FROM feedback WHERE category='Bug' AND created_at >= ? ORDER BY gravity_score DESC, created_at DESC LIMIT 10`).bind(date).all();
					results = res.results;
				} else if (intent === 'search') {
					const res = await env.FEEDBACK_DB.prepare(`SELECT * FROM feedback WHERE content LIKE ? ORDER BY gravity_score DESC, created_at DESC LIMIT 10`).bind(`%${params.term}%`).all();
					results = res.results;
				} else if (intent === 'summary') {
					const days = params.days || 7;
					const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
					const res = await env.FEEDBACK_DB.prepare(`SELECT * FROM feedback WHERE created_at >= ? ORDER BY created_at DESC LIMIT 50`).bind(date).all();
					results = res.results;
				} else if (intent === 'issue_drilldown') {
					const res = await env.FEEDBACK_DB.prepare(`SELECT * FROM feedback WHERE id = ? LIMIT 1`).bind(params.id).all();
					results = res.results;
				}

				// Step 3: Grounded Answer
				const answerPrompt = `You are a Product Feedback Copilot. Your goal is to provide a clean, high-signal UI using strictly formatted Markdown. Follow these structural rules precisely:

1. **Sequential Numbering**: In the Data Analysis section, every feedback entry must be numbered in a column (e.g., | 1 | ...).
2. **Mandatory Whitespace**: You must insert two full newlines (\\n\\n) between every section, header, horizontal rule, and table.
3. **Visual Hierarchy**: 
   - Use ### for main sections.
   - Use --- on its own line for separation.
   - **Bold** only critical data (Pull scores > 15 and status keywords).

### Required Output Template

### Executive Summary
[Brief summary of trends]

---

### Data Analysis
| # | Pull | Category | Source | Feedback Summary |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **20** | Bug | user-A | ... |
| 2 | 5 | Feature | user-B | ... |

---

### Action Plan
> **Priority 1**: [Numbered actionable step]
> **Priority 2**: [Numbered actionable step]

Do not invent data. If TOOL_DATA is empty, state that clearly.`;

				const toolData = `TOOL_DATA: ${JSON.stringify(results)}`;
				const answerResp = await runAIWithRetry(env, '@cf/meta/llama-3-8b-instruct', {
					messages: [
						{ role: 'system', content: answerPrompt },
						{ role: 'user', content: `User Query: ${query}\n\n${toolData}` }
					]
				});

				return new Response(JSON.stringify({ answer: (answerResp as any).response, intent, rows: results }), {
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (err: any) {
				console.error("Chat Error:", err);
				return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		}

		return new Response('Not Found', { status: 404 });
	},
};

// -----------------------------------------------------------------------------
// UI Helpers
// -----------------------------------------------------------------------------
function htmlUI(topIssues: any[] = []) {
	const listItems = topIssues.map(i => `
        <div class="bg-slate-900/50 p-3 rounded border border-slate-700/50 flex justify-between items-start">
            <div>
                <div class="text-sm text-slate-300 font-medium truncate max-w-[300px]">${i.content}</div>
                <div class="text-xs text-slate-500">${i.category} • ${i.source}</div>
            </div>
            <span class="text-xs font-mono font-bold text-purple-400 bg-purple-900/30 px-2 py-1 rounded ml-2">Pull: ${i.gravity_score}</span>
        </div>
    `).join('');

	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Feedback Copilot</title>
		<script src="https://cdn.tailwindcss.com"></script>
		<script src="https://unpkg.com/marked"></script>
	</head>
	<body class="bg-slate-950 text-white min-h-screen p-8 transition-colors duration-500">
		<div class="max-w-5xl mx-auto space-y-8 flex gap-8">
            
            <!-- Main Chat Area -->
            <div class="flex-1 space-y-8">
                <header class="flex justify-between items-center">
                    <h1 class="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-indigo-400">Feedback Copilot</h1>
                </header>

                <div class="bg-slate-900/80 backdrop-blur p-6 rounded-2xl border border-slate-700/50 h-[600px] flex flex-col shadow-2xl shadow-purple-900/10">
                    <div id="chatHistory" class="flex-1 overflow-y-auto space-y-4 mb-4 pr-2">
                        <div class="flex justify-start"><div class="bg-slate-800 rounded-2xl rounded-tl-sm p-4 max-w-[85%] text-sm text-slate-200 border border-slate-700">
                            Hello! I'm your Product Feedback Copilot. I analyze the "pull" of user issues.
                        </div></div>
                    </div>
                    
                    <div class="flex gap-2 mb-4 overflow-x-auto pb-2 scrollbar-hide">
                        <button onclick="sendQuick('Show me top issues')" class="whitespace-nowrap bg-slate-800 hover:bg-purple-900/30 hover:border-purple-500/50 px-3 py-1.5 rounded-full text-xs text-purple-300 border border-slate-600 transition-all">🔥 Top Issues</button>
                        <button onclick="sendQuick('Show me critical bugs from the last 24h')" class="whitespace-nowrap bg-slate-800 hover:bg-red-900/30 hover:border-red-500/50 px-3 py-1.5 rounded-full text-xs text-red-300 border border-slate-600 transition-all">🚨 Bugs 24h</button>
                        <button onclick="sendQuick('Give me a weekly summary')" class="whitespace-nowrap bg-slate-800 hover:bg-emerald-900/30 hover:border-emerald-500/50 px-3 py-1.5 rounded-full text-xs text-emerald-300 border border-slate-600 transition-all">📊 Weekly Summary</button>
                    </div>

                    <form id="chatForm" class="flex gap-3 relative">
                        <input id="chatInput" type="text" placeholder="Ask about feedback trends..." class="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-4 text-sm focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 outline-none transition-all shadow-inner">
                        <button type="submit" class="bg-purple-600 hover:bg-purple-500 text-white p-4 rounded-xl font-medium transition-all shadow-lg shadow-purple-900/20">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
                        </button>
                    </form>
                </div>
            </div>

            <!-- Sidebar -->
            <div class="w-80 space-y-6">
                <!-- Navigation -->
                 <div class="bg-slate-900/80 backdrop-blur p-4 rounded-xl border border-slate-700/50">
                    <a href="/dashboard" class="block w-full text-center bg-slate-800 hover:bg-slate-700 text-slate-300 py-2 rounded-lg text-sm font-medium transition-colors border border-slate-700">
                        View Full Dashboard →
                    </a>
                </div>

                <!-- Mock Ingest -->
                <div class="bg-slate-900/80 backdrop-blur p-5 rounded-xl border border-slate-700/50 space-y-3">
                    <h3 class="text-xs font-bold uppercase tracking-widest text-slate-500">Actions</h3>
                    <button id="mockIngestBtn" class="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white py-2 rounded-lg text-sm font-bold shadow-lg shadow-purple-900/20 transition-all active:scale-95">
                        🎲 Mock Ingest
                    </button>
                    <p class="text-[10px] text-slate-600 text-center">Generates a random feedback entry</p>
                </div>

                <!-- Top Pull List -->
                <div class="bg-slate-900/80 backdrop-blur p-5 rounded-xl border border-slate-700/50 space-y-4">
                     <h3 class="text-xs font-bold uppercase tracking-widest text-slate-500 flex justify-between">
                        <span>Top 5 Pull</span>
                        <span class="text-purple-400">⚡️</span>
                     </h3>
                     <div class="space-y-3">
                        ${listItems || '<div class="text-slate-600 text-xs italic text-center py-4">No data yet</div>'}
                     </div>
                </div>
            </div>
		</div>

		<script>
            // Mock Ingest Logic
            document.getElementById('mockIngestBtn').addEventListener('click', async () => {
                const btn = document.getElementById('mockIngestBtn');
                const originalText = btn.innerText;
                btn.innerText = 'Runing...';
                btn.disabled = true;
                
                try {
                    await fetch('/ingest', { method: 'POST', body: '{}' }); // Empty body triggers random
                    window.location.reload();
                } catch(e) {
                    alert('Ingest failed');
                    btn.innerText = originalText;
                    btn.disabled = false;
                }
            });

			const chatHistory = document.getElementById('chatHistory');
			
			function addMsg(html, isUser) {
				const div = document.createElement('div');
				div.className = \`flex \${isUser ? 'justify-end' : 'justify-start'}\`;
				div.innerHTML = isUser 
                    ? \`<div class="bg-purple-600 text-white rounded-2xl rounded-tr-sm p-3 max-w-[85%] text-sm shadow-md">\${html}</div>\` 
                    : \`<div class="bg-slate-800 border border-slate-700 text-slate-200 rounded-2xl rounded-tl-sm p-4 max-w-[85%] text-sm shadow-sm prose prose-invert prose-sm">\${html}</div>\`;
				chatHistory.appendChild(div);
				chatHistory.scrollTop = chatHistory.scrollHeight;
			}

            function sendQuick(text) {
                document.getElementById('chatInput').value = text;
                document.getElementById('chatForm').requestSubmit();
            }

			document.getElementById('chatForm').addEventListener('submit', async (e) => {
				e.preventDefault();
				const input = document.getElementById('chatInput');
				const query = input.value;
				if(!query) return;
				
				addMsg(query, true);
				input.value = '';
                
                // Show loading state
                const loadingDiv = document.createElement('div');
                loadingDiv.id = 'loading';
                loadingDiv.className = 'flex justify-start';
                loadingDiv.innerHTML = '<div class="bg-slate-800 rounded-2xl rounded-tl-sm p-4 text-sm text-slate-400 animate-pulse border border-slate-700">Thinking...</div>';
                chatHistory.appendChild(loadingDiv);
                chatHistory.scrollTop = chatHistory.scrollHeight;
				
				try {
					const res = await fetch('/chat', {
						method: 'POST',
						body: JSON.stringify({ query }),
						headers: { 'Content-Type': 'application/json' }
					});
                    
                    document.getElementById('loading').remove();
                    
                    if (res.status === 401) {
                        addMsg("⚠️ Unauthorized. Please access via Cloudflare Access.", false);
                        return;
                    }

                    if (!res.ok) {
                        const txt = await res.text();
                        throw new Error(\`Server error \${res.status}: \${txt}\`);
                    }

					const data = await res.json();
                    
                    if (!data.answer) {
                        console.error('No answer in data:', data);
                        throw new Error('Response missing "answer" field');
                    }
                    
                    if (typeof marked === 'undefined') {
                        addMsg(data.answer, false);
                    } else {
                        // Configure marked for breaks
                        marked.use({ breaks: true, gfm: true });
                        addMsg(marked.parse(data.answer), false);
                    }

				} catch(err) {
                    console.error(err);
                    if(document.getElementById('loading')) document.getElementById('loading').remove();
					addMsg(\`❌ Error: \${err.message}\`, false);
				}
			});
		</script>
	</body>
	</html>
	`;
}

function htmlDashboard(items: any[]) {
	const rows = items.map(i => {
		// Physics Theme Badges
		let badgeClass = 'bg-blue-900/30 text-blue-300 border-blue-700/50';
		let badgeLabel = 'Low Pull';

		if (i.gravity_score >= 6) {
			badgeClass = 'bg-red-900/30 text-red-300 border-red-500/50';
			badgeLabel = 'High Pull';
		} else if (i.gravity_score >= 3) {
			badgeClass = 'bg-amber-900/30 text-amber-300 border-amber-500/50';
			badgeLabel = 'Medium Pull';
		}

		return `
		<tr class="border-b border-slate-800 hover:bg-slate-800/30 transition group">
			<td class="p-4 font-mono">
                <div class="flex flex-col items-start gap-1">
                    <span class="text-lg font-bold ${i.gravity_score >= 6 ? 'text-white' : 'text-slate-400'}">${i.gravity_score}</span>
                    <span class="px-2 py-0.5 rounded text-[10px] uppercase tracking-wide font-bold border ${badgeClass}">${badgeLabel}</span>
                </div>
            </td>
			<td class="p-4 align-top pt-5">
                <span class="px-2 py-1 rounded text-xs bg-slate-900 border border-slate-700 text-slate-400">${i.category}</span>
            </td>
			<td class="p-4 align-top pt-5">
                <div class="mb-1 text-slate-200 group-hover:text-white transition-colors text-sm">${i.content}</div>
                <div class="text-xs text-slate-500 font-mono border-l-2 border-slate-700 pl-2 mt-1">${i.explanation || 'No analysis'}</div>
            </td>
			<td class="p-4 text-slate-500 text-xs align-top pt-5">${i.source}</td>
            <td class="p-4 text-slate-500 text-xs text-right whitespace-nowrap align-top pt-5">${new Date(i.created_at).toLocaleDateString()}</td>
		</tr>
	`}).join('');

	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Dashboard</title>
		<script src="https://cdn.tailwindcss.com"></script>
	</head>
	<body class="bg-slate-950 text-white min-h-screen p-8">
		<div class="max-w-6xl mx-auto">
			<header class="flex justify-between items-center mb-12">
				<div>
                    <h1 class="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-indigo-400">Feedback Dashboard</h1>
                    <p class="text-slate-500 text-sm mt-1">Global issue pull monitoring</p>
                </div>
				<a href="/app" class="px-4 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-300 hover:text-white hover:border-purple-500 transition-all text-sm font-medium">← Back to Copilot</a>
			</header>
			
			<div class="bg-slate-900/50 rounded-2xl border border-slate-800 overflow-hidden shadow-2xl shadow-black/50">
				<table class="w-full text-left">
					<thead class="bg-slate-900 text-slate-500 uppercase text-[10px] tracking-widest font-bold border-b border-slate-800">
						<tr>
							<th class="p-4">Pull Score</th>
							<th class="p-4">Category</th>
							<th class="p-4 w-1/2">Feedback Payload</th>
							<th class="p-4">Source</th>
                            <th class="p-4 text-right">Captured</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-800/50">
						${rows}
					</tbody>
				</table>
				${items.length === 0 ? '<div class="p-20 text-center text-slate-600">No feedback found. Use the Copilot to Ingest data.</div>' : ''}
			</div>
		</div>
	</body>
	</html>
	`;
}


async function runAIWithRetry(env: Env, model: any, inputs: any, retries = 2) {
	for (let i = 0; i <= retries; i++) {
		try {
			return await env.AI.run(model, inputs);
		} catch (e: any) {
			console.error(`AI Attempt ${i + 1} failed:`, e.message);
			if (i === retries) throw e;
			// Linear backoff: 1s, 2s...
			await new Promise(r => setTimeout(r, 1000 * (i + 1)));
		}
	}
}

function requireAuth(request: Request): boolean {
	const url = new URL(request.url);
	// Allow local dev without headers
	if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;

	const email = request.headers.get('Cf-Access-Authenticated-User-Email') ||
		request.headers.get('cf-access-authenticated-user-email');
	return !!email;
}
