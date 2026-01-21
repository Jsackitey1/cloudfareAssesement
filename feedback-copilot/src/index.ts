import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

interface Env {
    DB: D1Database;
    AI: any;
    WORKFLOW: Workflow;
}

// -----------------------------------------------------------------------------
// Workflows: Enriches feedback with AI
// -----------------------------------------------------------------------------
type FeedbackEvent = {
    id?: number;
    text: string;
    source: string;
};

export class FeedbackWorkflow extends WorkflowEntrypoint<Env, FeedbackEvent> {
    async run(event: WorkflowEvent<FeedbackEvent>, step: WorkflowStep) {
        const { text, source } = event.payload;

        // Step 1: Analyze text with AI
        const analysis = await step.do('analyze-feedback', async () => {
            const prompt = `
			Analyze this feedback and output strict JSON.
			Feedback: "${text}"
			
			Output format:
			{
				"sentiment": <number between 0 and 1, 1 is positive>,
				"gravity_score": <integer 1-10, 10 is critical>,
				"category": "<string, e.g. Feature, Bug, Performance, Other>"
			}
			`;

            const response = await this.env.AI.run('@cf/meta/llama-3-8b-instruct', {
                messages: [{ role: 'user', content: prompt }]
            });

            // Simple parsing, assuming strict JSON as requested, but robust fallback
            try {
                let jsonStr = response.response;
                // Attempt to find JSON if wrapped in markdown
                const match = jsonStr.match(/\{[\s\S]*\}/);
                if (match) jsonStr = match[0];
                return JSON.parse(jsonStr);
            } catch (e) {
                return { sentiment: 0.5, gravity_score: 5, category: 'Unknown' };
            }
        });

        // Step 2: Store in D1
        await step.do('store-db', async () => {
            await this.env.DB.prepare(
                `INSERT INTO feedback (text, source, sentiment, gravity_score, category) VALUES (?, ?, ?, ?, ?)`
            )
                .bind(text, source, analysis.sentiment, analysis.gravity_score, analysis.category)
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

        // GET /app - Chat UI
        if (request.method === 'GET' && url.pathname === '/app') {
            return new Response(htmlUI(), {
                headers: { 'Content-Type': 'text/html' },
            });
        }

        // GET /dashboard - Simple List
        if (request.method === 'GET' && url.pathname === '/dashboard') {
            const { results } = await env.DB.prepare(
                `SELECT * FROM feedback ORDER BY gravity_score DESC, created_at DESC LIMIT 50`
            ).all();
            return new Response(htmlDashboard(results), {
                headers: { 'Content-Type': 'text/html' },
            });
        }

        // POST /ingest - Trigger Workflow
        if (request.method === 'POST' && url.pathname === '/ingest') {
            const body = await request.json() as { text: string; source: string };
            if (!body.text) return new Response('Missing text', { status: 400 });

            await env.WORKFLOW.create({
                params: {
                    text: body.text,
                    source: body.source || 'api'
                }
            });

            return new Response(JSON.stringify({ status: 'queued' }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // POST /chat - RAG-lite
        if (request.method === 'POST' && url.pathname === '/chat') {
            const body = await request.json() as { query: string };
            const query = body.query;

            // 1. Fetch relevant context (naive: top gravity items)
            const { results } = await env.DB.prepare(
                `SELECT text, category, gravity_score FROM feedback ORDER BY gravity_score DESC LIMIT 20`
            ).all();
            const context = results.map((r: any) => `- [${r.category}, Score ${r.gravity_score}]: ${r.text}`).join('\n');

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
					body: JSON.stringify({ text, source }),
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
			<td class="p-4 text-slate-300">${i.text}</td>
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
