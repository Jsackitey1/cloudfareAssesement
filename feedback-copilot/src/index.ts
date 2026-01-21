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
			return new Response(htmlUI(), {
				headers: { 'Content-Type': 'text/html' },
			});
		}

		// GET /dashboard - Simple List
		if (request.method === 'GET' && url.pathname === '/dashboard') {
			const { results } = await env.FEEDBACK_DB.prepare(
				`SELECT * FROM feedback ORDER BY gravity_score DESC, created_at DESC LIMIT 50`
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
			const body = await request.json() as { query: string };
			const query = body.query;

			// 1. Fetch relevant context
			const { results } = await env.FEEDBACK_DB.prepare(
				`SELECT content, category, gravity_score, explanation FROM feedback ORDER BY gravity_score DESC LIMIT 20`
			).all();
			const context = results.map((r: any) => `- [${r.category}, Score ${r.gravity_score}]: ${r.content} (${r.explanation})`).join('\n');

			// 2. Generate answer
			const systemPrompt = `You are Feedback Copilot. Answer the user query based on the feedback context provided. Verify your claims with the context.`;
			const userPrompt = `Context:\n${context}\n\nUser Query: ${query}`;

			const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userPrompt }
				]
			});

			return new Response(JSON.stringify({ answer: response.response, contextUsed: results.length }), {
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
		</script>
	</body>
	</html>
	`;
}

function htmlDashboard(items: any[]) {
	const rows = items.map(i => `
		<tr class="border-b border-slate-700">
			<td class="p-4 text-emerald-400 font-mono">${i.gravity_score}</td>
			<td class="p-4">${i.category}</td>
			<td class="p-4 text-slate-300">${i.content} <br><span class="text-xs text-slate-500">${i.explanation || ''}</span></td>
			<td class="p-4 text-slate-400 text-sm">${i.source}</td>
		</tr>
	`).join('');

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
				${items.length === 0 ? '<div class="p-8 text-center text-slate-500">No feedback found. Ingest some data first!</div>' : ''}
			</div>
		</div>
	</body>
	</html>
	`;
}
