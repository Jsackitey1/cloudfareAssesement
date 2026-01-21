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

			const response = await this.env.AI.run('@cf/meta/llama-3-8b-instruct', {
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

			return new Response(htmlUI(), {
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

			const intentResp = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
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
You must answer using ONLY the provided data in TOOL_DATA. Do not invent issues, numbers, trends, or ids not present in TOOL_DATA.
If TOOL_DATA is empty, say you found no matching feedback and suggest a next query the PM could try.
Tone: concise, PM-friendly, action-oriented.
Output format:
- Start with a 1–2 sentence summary.
- Then bullets of up to 5 items. Each bullet includes:
  gravity_score, category, source, created_at, short paraphrase, one suggested next step.
- End with one follow-up question to help next decision.
Do not mention SQL, databases, or internal tooling.
Do not output markdown tables.`;

			const toolData = `TOOL_DATA: ${JSON.stringify(results)}`;
			const answerResp = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
				messages: [
					{ role: 'system', content: answerPrompt },
					{ role: 'user', content: `User Query: ${query}\n\n${toolData}` }
				]
			});

			return new Response(JSON.stringify({ answer: (answerResp as any).response, intent, rows: results }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response('Not Found', { status: 404 });
	},
};

// -----------------------------------------------------------------------------
// UI Helpers
// -----------------------------------------------------------------------------
function htmlUI() {
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
	<body class="bg-slate-900 text-white min-h-screen p-8">
		<div class="max-w-4xl mx-auto space-y-8">
			<header class="flex justify-between items-center">
				<h1 class="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-emerald-400">Feedback Copilot</h1>
				<a href="/dashboard" class="text-slate-400 hover:text-white underline">View Dashboard</a>
			</header>

			<!-- Chat Section -->
			<div class="bg-slate-800 p-6 rounded-xl border border-slate-700 h-[600px] flex flex-col">
				<div id="chatHistory" class="flex-1 overflow-y-auto space-y-4 mb-4 pr-2">
					<div class="flex justify-start"><div class="bg-slate-700 rounded-lg p-3 max-w-[80%] text-sm">Hello! I'm your Product Feedback Copilot. Ask me about top issues, recent bugs, or summaries.</div></div>
				</div>
				
				<div class="flex gap-2 mb-4 overflow-x-auto pb-2">
					<button onclick="sendQuick('Show me top issues')" class="whitespace-nowrap bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded-full text-xs text-blue-300 border border-slate-600">Top Issues</button>
					<button onclick="sendQuick('Show me critical bugs from the last 24h')" class="whitespace-nowrap bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded-full text-xs text-red-300 border border-slate-600">Bugs 24h</button>
					<button onclick="sendQuick('Give me a weekly summary')" class="whitespace-nowrap bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded-full text-xs text-emerald-300 border border-slate-600">Weekly Summary</button>
				</div>

				<form id="chatForm" class="flex gap-2">
					<input id="chatInput" type="text" placeholder="Ask your data..." class="flex-1 bg-slate-900 border border-slate-700 rounded p-3 text-sm focus:ring-2 focus:ring-emerald-500 outline-none">
					<button type="submit" class="bg-emerald-600 hover:bg-emerald-500 px-6 py-2 rounded font-medium transition">Send</button>
				</form>
			</div>

            <!-- Server-rendered quick list (optional/future) -->
            <div class="mt-8 pt-8 border-t border-slate-800 text-center text-slate-500 text-sm">
                Feedback Copilot v1.0
            </div>
		</div>

		<script>
			const chatHistory = document.getElementById('chatHistory');
			
			function addMsg(html, isUser) {
				const div = document.createElement('div');
				div.className = \`flex \${isUser ? 'justify-end' : 'justify-start'}\`;
				div.innerHTML = \`<div class="\${isUser ? 'bg-blue-600' : 'bg-slate-700'} rounded-lg p-3 max-w-[85%] text-sm prose prose-invert">\${html}</div>\`;
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
                loadingDiv.innerHTML = '<div class="bg-slate-700 rounded-lg p-3 text-sm text-slate-400 animate-pulse">Thinking...</div>';
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

					const data = await res.json();
                    // Render markdown answer
                    addMsg(marked.parse(data.answer), false);
				} catch(err) {
                    if(document.getElementById('loading')) document.getElementById('loading').remove();
					addMsg('Error getting response.', false);
				}
			});
		</script>
	</body>
	</html>
	`;
}

function htmlDashboard(items: any[]) {
	const rows = items.map(i => {
		let badgeColor = 'bg-slate-700 text-slate-300';
		if (i.gravity_score >= 20) badgeColor = 'bg-red-900 text-red-200 border border-red-700';
		else if (i.gravity_score >= 10) badgeColor = 'bg-orange-900 text-orange-200 border border-orange-700';
		else if (i.gravity_score >= 5) badgeColor = 'bg-yellow-900 text-yellow-200 border border-yellow-700';

		return `
		<tr class="border-b border-slate-700 hover:bg-slate-800/50 transition">
			<td class="p-4 font-mono">
                <span class="px-2 py-1 rounded text-xs font-bold ${badgeColor}">${i.gravity_score}</span>
            </td>
			<td class="p-4">
                <span class="px-2 py-1 rounded text-xs bg-slate-800 border border-slate-600">${i.category}</span>
            </td>
			<td class="p-4 text-slate-300">
                <div class="mb-1">${i.content}</div>
                <div class="text-xs text-slate-500 font-mono">${i.explanation || ''}</div>
            </td>
			<td class="p-4 text-slate-400 text-sm">${i.source}</td>
            <td class="p-4 text-slate-500 text-xs text-right whitespace-nowrap">${new Date(i.created_at).toLocaleDateString()}</td>
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
	<body class="bg-slate-900 text-white min-h-screen p-8">
		<div class="max-w-6xl mx-auto">
			<header class="flex justify-between items-center mb-8">
				<h1 class="text-3xl font-bold">Feedback Dashboard</h1>
				<a href="/app" class="text-blue-400 hover:text-blue-300 underline">Back to Copilot</a>
			</header>
			
			<div class="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-2xl">
				<table class="w-full text-left">
					<thead class="bg-slate-900 text-slate-400 uppercase text-xs tracking-wider">
						<tr>
							<th class="p-4">Gravity</th>
							<th class="p-4">Category</th>
							<th class="p-4 w-1/2">Feedback</th>
							<th class="p-4">Source</th>
                            <th class="p-4 text-right">Date</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-700">
						${rows}
					</tbody>
				</table>
				${items.length === 0 ? '<div class="p-12 text-center text-slate-500">No feedback found. Ingest some data first!</div>' : ''}
			</div>
		</div>
	</body>
	</html>
	`;
}

function requireAuth(request: Request): boolean {
	const email = request.headers.get('Cf-Access-Authenticated-User-Email') ||
		request.headers.get('cf-access-authenticated-user-email');
	return !!email;
}
