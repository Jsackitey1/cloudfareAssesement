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
			// const auth = requireAuth(request);
			// if (!auth) return new Response('Unauthorized', { status: 401 });

			const { results } = await env.FEEDBACK_DB.prepare(
				`SELECT * FROM feedback ORDER BY gravity_score DESC, created_at DESC LIMIT 5`
			).all();

			return new Response(htmlUI(results), {
				headers: { 'Content-Type': 'text/html' },
			});
		}

		// GET /dashboard - Simple List
		if (request.method === 'GET' && url.pathname === '/dashboard') {
			// const auth = requireAuth(request);
			// if (!auth) return new Response('Unauthorized', { status: 401 });

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
				// const auth = requireAuth(request);
				// if (!auth) return new Response('Unauthorized', { status: 401 });

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
				const answerPrompt = `You are a Product Feedback Copilot used by PMs.
Return ONLY valid JSON that matches the schema exactly. Do not include markdown, tables, or extra keys.

Schema:
{
  "summary": {
    "headline": string,
    "details": string,
    "stats": [
      {"label": string, "value": string}
    ]
  },
  "top_issues": [
    {
      "rank": number,
      "id": string,
      "pull": number,
      "heat": "High"|"Medium"|"Low",
      "category": "Bug"|"UX"|"Feature"|"Other",
      "source": string,
      "title": string,
      "one_liner": string,
      "next_step": string
    }
  ],
  "patterns": [
    {"label": string, "evidence": string}
  ],
  "follow_up_question": string
}

Rules:
- Output JSON only.
- Use ONLY the provided TOOL_DATA. Never invent ids or issues.
- If TOOL_DATA is empty, return:
  summary.headline='No matching feedback found'
  top_issues=[]
  patterns=[]
  follow_up_question suggests a query refinement.
- title must be short (max 8 words).
- one_liner max 18 words.
- next_step max 12 words, action verb first.
- heat must be derived from pull:
  pull >= 6 => High
  pull >= 3 => Medium
  else => Low
- stats should include: total_items, bug_count, ux_count, feature_count (as strings).`;

				const toolData = `TOOL_DATA: ${JSON.stringify(results)}`;
				const answerResp = await runAIWithRetry(env, '@cf/meta/llama-3-8b-instruct', {
					messages: [
						{ role: 'system', content: answerPrompt },
						{ role: 'user', content: `USER_QUESTION: ${query}\nTOOL_DATA: ${toolData}\nNOW_ISO: ${new Date().toISOString()}` }
					],
					max_tokens: 2500
				});

				let parsedAnswer = {};
				try {
					let jsonStr = (answerResp as any).response;
					console.log("Raw AI Response:", jsonStr);

					// Robust JSON extraction
					jsonStr = jsonStr.replace(/```json/g, '').replace(/```/g, '');
					const firstOpen = jsonStr.indexOf('{');
					const lastClose = jsonStr.lastIndexOf('}');
					if (firstOpen !== -1 && lastClose !== -1) {
						jsonStr = jsonStr.substring(firstOpen, lastClose + 1);
					}
					parsedAnswer = JSON.parse(jsonStr);
				} catch (e) {
					console.error("Failed to parse Final Answer JSON", e);
					parsedAnswer = {
						summary: { headline: "Error analyzing data", details: "The AI returned an invalid format.", stats: [] },
						top_issues: [], patterns: [], follow_up_question: "Try a simpler query."
					};
				}

				return new Response(JSON.stringify(parsedAnswer), {
					headers: { 'Content-Type': 'application/json' }
				});

			} catch (err: any) {
				console.error("Chat Error:", err);
				return new Response(JSON.stringify({
					summary: { headline: "System Error", details: err.message, stats: [] },
					top_issues: [], patterns: [], follow_up_question: "Please try again later."
				}), { status: 500, headers: { 'Content-Type': 'application/json' } });
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
	</head>
	<body class="bg-slate-950 text-white min-h-screen p-8 transition-colors duration-500 font-sans">
		<div class="max-w-5xl mx-auto space-y-8 flex gap-8">
            
            <!-- Main Chat Area -->
            <div class="flex-1 space-y-8">
                <header class="flex justify-between items-center">
                    <h1 class="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-indigo-400">Feedback Copilot</h1>
                </header>

                <div class="bg-slate-900/80 backdrop-blur p-6 rounded-2xl border border-slate-700/50 h-[700px] flex flex-col shadow-2xl shadow-purple-900/10">
                    <div id="chatHistory" class="flex-1 overflow-y-auto space-y-6 mb-4 pr-2">
                        <div class="flex justify-start">
                            <div class="bg-slate-800 rounded-2xl rounded-tl-sm p-4 max-w-[90%] text-sm text-slate-200 border border-slate-700 shadow-md">
                                Hello! I'm your Product Feedback Copilot. I analyze the "pull" of user issues.
                            </div>
                        </div>
                    </div>
                    
                    <div class="flex gap-2 mb-4 overflow-x-auto pb-2 scrollbar-hide">
                        <button onclick="sendQuick('Show me top issues')" class="whitespace-nowrap bg-slate-800 hover:bg-purple-900/30 hover:border-purple-500/50 px-3 py-1.5 rounded-full text-xs text-purple-300 border border-slate-600 transition-all">🔥 Top Issues</button>
                        <button onclick="sendQuick('Show me critical bugs from the last 24h')" class="whitespace-nowrap bg-slate-800 hover:bg-red-900/30 hover:border-red-500/50 px-3 py-1.5 rounded-full text-xs text-red-300 border border-slate-600 transition-all">🚨 Bugs 24h</button>
                        <button onclick="sendQuick('Give me a weekly summary')" class="whitespace-nowrap bg-slate-800 hover:bg-emerald-900/30 hover:border-emerald-500/50 px-3 py-1.5 rounded-full text-xs text-emerald-300 border border-slate-600 transition-all">📊 Weekly Summary</button>
                    </div>

                    <form id="chatForm" class="flex gap-3 relative">
                        <input id="chatInput" type="text" placeholder="Ask about feedback trends..." class="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-4 text-sm focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 outline-none transition-all shadow-inner placeholder-slate-600">
                        <button type="submit" class="bg-purple-600 hover:bg-purple-500 text-white p-4 rounded-xl font-medium transition-all shadow-lg shadow-purple-900/20 active:scale-95">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
                        </button>
                    </form>
                </div>
            </div>

            <!-- Sidebar -->
            <div class="w-80 space-y-6">
                <!-- Navigation -->
                 <div class="bg-slate-900/80 backdrop-blur p-4 rounded-xl border border-slate-700/50 shadow-lg">
                    <a href="/dashboard" class="block w-full text-center bg-slate-800 hover:bg-slate-700 text-slate-300 py-2 rounded-lg text-sm font-medium transition-colors border border-slate-700 hover:border-purple-500/50">
                        View Full Dashboard →
                    </a>
                </div>

                <!-- Mock Ingest -->
                <div class="bg-slate-900/80 backdrop-blur p-5 rounded-xl border border-slate-700/50 space-y-3 shadow-lg">
                    <h3 class="text-xs font-bold uppercase tracking-widest text-slate-500">Actions</h3>
                    <button id="mockIngestBtn" class="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white py-2 rounded-lg text-sm font-bold shadow-lg shadow-purple-900/20 transition-all active:scale-95">
                        🎲 Mock Ingest
                    </button>
                    <p class="text-[10px] text-slate-600 text-center">Generates a random feedback entry</p>
                </div>

                <!-- Top Pull List -->
                <div class="bg-slate-900/80 backdrop-blur p-5 rounded-xl border border-slate-700/50 space-y-4 shadow-lg">
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
				div.className = \`flex \${isUser ? 'justify-end' : 'justify-start w-full'}\`;
				div.innerHTML = isUser 
                    ? \`<div class="bg-purple-600 text-white rounded-2xl rounded-tr-sm p-3 max-w-[85%] text-sm shadow-md mb-2">\${html}</div>\` 
                    : \`<div class="max-w-[100%] w-full animate-fade-in">\${html}</div>\`;
				chatHistory.appendChild(div);
				chatHistory.scrollTop = chatHistory.scrollHeight;
			}

            function renderChatResponse(data) {
                if (!data || !data.summary) return '<div class="text-red-400 p-2">Invalid response format</div>';

                // 1. Summary Card
                let html = \`
                    <div class="bg-slate-800 rounded-xl border border-slate-700 p-4 mb-4 shadow-lg">
                        <h3 class="text-md font-bold text-white mb-1">\${data.summary.headline}</h3>
                        <p class="text-slate-400 text-sm mb-3 leading-relaxed">\${data.summary.details}</p>
                        <div class="flex flex-wrap gap-2">
                \`;
                
                // Stats Chips
                if (data.summary.stats) {
                    data.summary.stats.forEach(s => {
                        html += \`
                            <span class="px-2 py-1 rounded bg-slate-700/50 border border-slate-600 text-xs text-slate-300 font-mono">
                                <span class="text-slate-500 mr-1">\${s.label}:</span>\${s.value}
                            </span>
                        \`;
                    });
                }
                html += \`</div></div>\`;

                // 2. Top Issues Cards
                if (data.top_issues && data.top_issues.length > 0) {
                     html += \`<div class="space-y-3 mb-4">\`;
                     data.top_issues.forEach(issue => {
                        let badgeColor = 'bg-blue-900/30 text-blue-300 border-blue-700/50';
                        if (issue.heat === 'High') badgeColor = 'bg-red-900/30 text-red-300 border-red-500/50';
                        if (issue.heat === 'Medium') badgeColor = 'bg-amber-900/30 text-amber-300 border-amber-500/50';

                        html += \`
                            <div class="bg-slate-900/40 rounded-lg border border-slate-700/50 p-3 hover:bg-slate-800/60 transition-colors group">
                                <div class="flex justify-between items-start mb-1">
                                    <div class="flex items-center gap-2">
                                        <span class="text-xs font-bold text-slate-500">#\${issue.rank}</span>
                                        <span class="px-1.5 py-0.5 rounded text-[10px] font-bold border \${badgeColor}">\${issue.heat}</span>
                                        <span class="text-xs text-slate-400 border border-slate-700 px-1 rounded">\${issue.category}</span>
                                    </div>
                                    <span class="text-xs font-mono font-bold text-slate-500 group-hover:text-purple-400 transition-colors">Pull: \${issue.pull}</span>
                                </div>
                                <div class="font-medium text-slate-200 text-sm mb-1">\${issue.title}</div>
                                <div class="text-xs text-slate-500 mb-2 line-clamp-2">\${issue.one_liner}</div>
                                <div class="flex items-center text-[10px] text-purple-300 gap-1 bg-purple-900/10 px-2 py-1 rounded w-fit">
                                    <span class="opacity-50 uppercase tracking-widest">Next:</span> \${issue.next_step}
                                </div>
                            </div>
                        \`;
                     });
                     html += \`</div>\`;
                }

                // 3. Follow-up
                if (data.follow_up_question) {
                     html += \`
                        <div class="flex justify-end mt-2">
                            <button onclick="sendQuick('\${data.follow_up_question}')" class="text-xs text-indigo-400 hover:text-indigo-300 hover:underline flex items-center gap-1 transition-colors">
                                \${data.follow_up_question}
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
                            </button>
                        </div>
                     \`;
                }

                return html;
            }

            function sendQuick(text) {
                document.getElementById('chatInput').value = text;
                document.getElementById('chatForm').requestSubmit();
            }

			// Add Chat Form Listener
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
                loadingDiv.innerHTML = \`<div class="bg-slate-800 rounded-xl p-4 w-48 animate-pulse flex items-center justify-center text-xs text-slate-500 border border-slate-700">Thinking...</div>\`;
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
                         addMsg('<div class="text-red-400 bg-red-900/20 p-3 rounded border border-red-800">⚠️ Unauthorized</div>', false);
                         return;
                    }

                    if (!res.ok) throw new Error(\`Server error \${res.status}\`);

					const data = await res.json();
                    const rendered = renderChatResponse(data);
                    addMsg(rendered, false);

				} catch(err) {
                    console.error(err);
                    if(document.getElementById('loading')) document.getElementById('loading').remove();
					addMsg(\`<div class="text-red-400 bg-red-900/20 p-3 rounded border border-red-800 text-xs">\${err.message}</div>\`, false);
				}
			});
		</script>
	</body>
	</html>
	`;
}

function htmlDashboard(items: any[]) {
	const cards = items.map(i => {
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
		<div class="bg-slate-900/50 rounded-xl border border-slate-700/50 p-5 hover:bg-slate-800/50 transition-all hover:scale-[1.01] hover:shadow-xl hover:shadow-purple-900/10 flex flex-col gap-3 group">
            <div class="flex justify-between items-start">
                <div class="flex flex-col">
                    <span class="text-2xl font-bold text-white group-hover:text-purple-400 transition-colors">${i.gravity_score}</span>
                    <span class="text-[10px] text-slate-500 uppercase tracking-wider font-bold">Pull Score</span>
                </div>
                <span class="px-2 py-1 rounded text-[10px] uppercase tracking-wide font-bold border ${badgeClass}">${badgeLabel}</span>
            </div>
            
            <div class="flex-1">
                <p class="text-slate-200 text-sm leading-relaxed">${i.content}</p>
                ${i.explanation ? `<p class="mt-2 text-xs text-slate-500 font-mono border-l-2 border-slate-700 pl-2">${i.explanation}</p>` : ''}
            </div>

            <div class="pt-3 border-t border-slate-800 flex justify-between items-center text-xs">
                <div class="flex gap-2">
                    <span class="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-400 font-medium">${i.category}</span>
                    <span class="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-500">${i.source}</span>
                </div>
                <span class="text-slate-600 font-mono">${new Date(i.created_at).toLocaleDateString()}</span>
            </div>
		</div>
		`;
	}).join('');

	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Feedback Dashboard</title>
		<script src="https://cdn.tailwindcss.com"></script>
	</head>
	<body class="bg-slate-950 text-white min-h-screen p-8 font-sans">
		<div class="max-w-6xl mx-auto space-y-8">
			<header class="flex justify-between items-center pb-6 border-b border-slate-800">
				<div>
                    <h1 class="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-indigo-400">Mission Control</h1>
                    <p class="text-slate-500 text-sm mt-1">Live feedback stream analyzed for "Pull"</p>
                </div>
				<a href="/app" class="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors border border-slate-700 flex items-center gap-2">
                    <span>← Back to Copilot</span>
                </a>
			</header>

            <!-- Stats Grid (Computed on fly for visuals) -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                    <div class="text-slate-500 text-xs uppercase tracking-wider font-bold mb-1">Total Signals</div>
                    <div class="text-2xl font-bold text-white">${items.length}</div>
                </div>
                <div class="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                    <div class="text-slate-500 text-xs uppercase tracking-wider font-bold mb-1">High Pull</div>
                    <div class="text-2xl font-bold text-red-400">${items.filter(i => i.gravity_score >= 6).length}</div>
                </div>
                 <div class="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                    <div class="text-slate-500 text-xs uppercase tracking-wider font-bold mb-1">Avg Pull</div>
                    <div class="text-2xl font-bold text-indigo-400">${items.length ? (items.reduce((a, b) => a + b.gravity_score, 0) / items.length).toFixed(1) : '0.0'}</div>
                </div>
            </div>

			<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				${cards}
			</div>
            
            ${items.length === 0 ? '<div class="text-center text-slate-600 py-12 italic">No feedback signals detected in sector.</div>' : ''}
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

// function requireAuth(request: Request): boolean {
// 	const url = new URL(request.url);
// 	// Allow local dev without headers
// 	if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;

// 	const email = request.headers.get('Cf-Access-Authenticated-User-Email') ||
// 		request.headers.get('cf-access-authenticated-user-email');
// 	return !!email;
// }
