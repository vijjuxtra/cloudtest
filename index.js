/**
 * AgentWorker — Upgraded Cloudflare Worker
 *
 * Features:
 * - Chat with Llama (with KV history per user)
 * - Task management (add, list, update, delete, skip, unskip)
 * - Daily cron runs tasks + self-reflects into R2
 * - Brave web search (agent decides when to use it)
 * - Agent edits its own R2 docs via API
 * - One-off /ask with memory + web search
 */

// ─── CORS headers ─────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ─── R2 keys ──────────────────────────────────────────────────────
const R2 = {
  TASKS:        "agent/tasks.json",
  MEMORY:       "agent/memory.md",
  INSTRUCTIONS: "agent/instructions.md",
  LOG:          "agent/log.json",
};

// ─── Router ───────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url    = new URL(request.url);
    const method = request.method;
    const path   = url.pathname;

    // Public chat endpoint — no auth
    if (method === "POST" && path === "/chat") return handleChat(request, env);

    // All other routes require Bearer token
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${env.AGENT_SECRET}`) return jsonRes({ error: "Unauthorized" }, 401);

    try {
      if (method === "POST"   && path === "/tasks")                                                      return handleAddTask(request, env);
      if (method === "GET"    && path === "/tasks")                                                      return handleListTasks(env);
      if (method === "DELETE" && path.startsWith("/tasks/"))                                             return handleDeleteTask(taskId(path), env);
      if (method === "PATCH"  && path.match(/^\/tasks\/[^/]+$/) && !path.endsWith("/skip") && !path.endsWith("/unskip")) return handleUpdateTask(taskId(path), request, env);
      if (method === "PATCH"  && path.match(/^\/tasks\/.+\/skip$/))                                     return handleSkipTask(skipId(path, "skip"), env, false);
      if (method === "PATCH"  && path.match(/^\/tasks\/.+\/unskip$/))                                   return handleSkipTask(skipId(path, "unskip"), env, true);
      if (method === "POST"   && path === "/run")                                                        { ctx.waitUntil(runDailyTasks(env)); return jsonRes({ message: "Daily run triggered. Check /log for results." }); }
      if (method === "GET"    && path === "/log")                                                        return handleGetLog(env);
      if (method === "GET"    && path === "/memory")                                                     return handleGetFile(R2.MEMORY, env);
      if (method === "GET"    && path === "/instructions")                                               return handleGetFile(R2.INSTRUCTIONS, env);
      if (method === "POST"   && path === "/edit")                                                       return handleEditFile(request, env);
      if (method === "POST"   && path === "/ask")                                                        return handleAsk(request, env);

      return jsonRes({ error: "Not found" }, 404);
    } catch (err) {
      return jsonRes({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyTasks(env));
  },
};

// ─── Chat (original behaviour preserved) ─────────────────────────

async function handleChat(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const { message, userId } = body;
  if (!message || !userId) {
    return new Response(JSON.stringify({ error: "message and userId required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  let history = await env.CHAT_KV.get(userId);
  history = history ? JSON.parse(history) : [];
  history.push({ role: "user", content: message });

  const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: history });
  const reply = aiResponse.response;

  history.push({ role: "assistant", content: reply });
  if (history.length > 40) history = history.slice(-40);
  await env.CHAT_KV.put(userId, JSON.stringify(history));

  return new Response(JSON.stringify({ reply }), { headers: { ...CORS, "Content-Type": "application/json" } });
}

// ─── Task Handlers ────────────────────────────────────────────────

async function handleAddTask(request, env) {
  const { title, description, schedule } = await request.json();
  if (!title || !description) return jsonRes({ error: "title and description required" }, 400);

  const tasks = await readTasks(env);
  const task = {
    id: crypto.randomUUID(), title, description,
    schedule: schedule || "daily",
    createdAt: new Date().toISOString(), lastRun: null, runCount: 0,
  };
  tasks.push(task);
  await writeTasks(tasks, env);
  await appendMemory(env, `[TASK ADDED] "${title}" — ${description} (${task.schedule})`);
  return jsonRes({ message: "Task added", task });
}

async function handleListTasks(env) {
  const tasks = await readTasks(env);
  return jsonRes({ count: tasks.length, tasks });
}

async function handleDeleteTask(id, env) {
  let tasks = await readTasks(env);
  const before = tasks.length;
  tasks = tasks.filter(t => t.id !== id);
  if (tasks.length === before) return jsonRes({ error: "Task not found" }, 404);
  await writeTasks(tasks, env);
  return jsonRes({ message: "Task deleted" });
}

async function handleUpdateTask(id, request, env) {
  const body = await request.json();
  const { title, description, schedule } = body;
  if (!title && !description && !schedule) return jsonRes({ error: "Provide at least one: title, description, schedule" }, 400);

  const tasks = await readTasks(env);
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return jsonRes({ error: "Task not found" }, 404);

  const before = { ...tasks[idx] };
  if (title)       tasks[idx].title       = title;
  if (description) tasks[idx].description = description;
  if (schedule)    tasks[idx].schedule    = schedule;
  tasks[idx].updatedAt = new Date().toISOString();

  await writeTasks(tasks, env);
  await appendMemory(env, `[TASK UPDATED] "${tasks[idx].title}" — changed: ${Object.keys(body).join(", ")}`);
  return jsonRes({ message: "Task updated", before, after: tasks[idx] });
}

async function handleSkipTask(id, env, unskip) {
  const tasks = await readTasks(env);
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return jsonRes({ error: "Task not found" }, 404);

  if (unskip) {
    delete tasks[idx].skipUntil;
    await writeTasks(tasks, env);
    return jsonRes({ message: `"${tasks[idx].title}" unskipped. Runs on next trigger.` });
  }

  const endOfToday = new Date();
  endOfToday.setUTCHours(23, 59, 59, 999);
  tasks[idx].skipUntil = endOfToday.toISOString();
  await writeTasks(tasks, env);
  return jsonRes({ message: `"${tasks[idx].title}" skipped for today. Resumes tomorrow.`, skipUntil: tasks[idx].skipUntil });
}

// ─── Daily Run ────────────────────────────────────────────────────

async function runDailyTasks(env) {
  const today   = new Date();
  const dayName = today.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
  const dateStr = today.toISOString().split("T")[0];

  const tasks        = await readTasks(env);
  const instructions = await readFile(R2.INSTRUCTIONS, env);
  const memory       = await readFile(R2.MEMORY, env);
  const log          = await readLog(env);
  const results      = [];

  for (const task of tasks) {
    if (task.schedule === "weekdays" && ["saturday", "sunday"].includes(dayName)) continue;
    if (task.schedule === "weekly"   && dayName !== "monday") continue;
    if (task.skipUntil && new Date() < new Date(task.skipUntil)) continue;

    const result = await executeTask(task, instructions, memory, env);
    task.lastRun = today.toISOString();
    task.runCount += 1;
    results.push({ taskId: task.id, title: task.title, result, ranAt: today.toISOString() });
  }

  await writeTasks(tasks, env);
  if (results.length > 0) await selfReflect(results, memory, env);

  log.push({ date: dateStr, tasksRun: results.length, results });
  await env.AGENT_BUCKET.put(R2.LOG, JSON.stringify(log.slice(-30), null, 2));
  return results;
}

async function executeTask(task, instructions, memory, env) {
  const system = `You are an autonomous AI agent.\n\nInstructions:\n${instructions}\n\nMemory:\n${memory}\n\nTo search the web respond ONLY with:\nSEARCH: <query>\n\nAlways end your final answer with: LEARNING: <one-line insight>`;
  return agenticLoop(system, `Execute this task:\nTitle: ${task.title}\nDescription: ${task.description}`, env);
}

async function selfReflect(results, memory, env) {
  const summary = results.map(r => `Task: ${r.title}\nResult: ${r.result}`).join("\n---\n");
  const reflection = await callLlama(env, `You completed today's tasks:\n\n${summary}\n\nCurrent memory:\n${memory}\n\nWrite 2-5 bullet learnings to append. Format: • [insight]`);
  await appendMemory(env, `\n## Reflection — ${new Date().toISOString().split("T")[0]}\n${reflection}`);
}

// ─── Edit & Ask ───────────────────────────────────────────────────

async function handleEditFile(request, env) {
  const { file, instruction } = await request.json();
  const map = { instructions: R2.INSTRUCTIONS, memory: R2.MEMORY, tasks: R2.TASKS };
  const key = map[file];
  if (!key)        return jsonRes({ error: "Invalid file. Choose: instructions, memory, tasks" }, 400);
  if (!instruction) return jsonRes({ error: "instruction is required" }, 400);

  const current = await readFile(key, env);
  const updated = await callLlama(env, `You are editing your agent file "${file}".\n\nCurrent:\n---\n${current}\n---\n\nInstruction: ${instruction}\n\nReturn ONLY the complete updated content. No markdown fences.`, 2048);
  await env.AGENT_BUCKET.put(key, updated);
  return jsonRes({ message: `"${file}" updated`, file, preview: updated.slice(0, 300) + (updated.length > 300 ? "..." : "") });
}

async function handleAsk(request, env) {
  const { question } = await request.json();
  if (!question) return jsonRes({ error: "question is required" }, 400);

  const instructions = await readFile(R2.INSTRUCTIONS, env);
  const memory       = await readFile(R2.MEMORY, env);
  const tasks        = await readTasks(env);

  const system = `You are an autonomous AI agent.\n\nInstructions:\n${instructions}\n\nMemory:\n${memory}\n\nTasks (${tasks.length}):\n${tasks.map(t => `- ${t.title}: ${t.description}`).join("\n")}\n\nTo search the web respond ONLY with:\nSEARCH: <query>\n\nBe concise.`;
  const answer = await agenticLoop(system, question, env);
  return jsonRes({ answer });
}

async function handleGetLog(env) {
  const log = await readLog(env);
  return jsonRes({ entries: log.length, log });
}

async function handleGetFile(key, env) {
  const content = await readFile(key, env);
  return new Response(content, { headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } });
}

// ─── Agentic Loop ─────────────────────────────────────────────────

async function agenticLoop(system, userPrompt, env, maxSteps = 5) {
  const messages = [{ role: "system", content: system }, { role: "user", content: userPrompt }];

  for (let i = 0; i < maxSteps; i++) {
    const response = await callLlamaMessages(env, messages);
    const match    = response.match(/^SEARCH:\s*(.+)$/m);
    if (match) {
      const results = await braveSearch(match[1].trim(), env);
      messages.push({ role: "assistant", content: response });
      messages.push({ role: "user", content: `Search results for "${match[1].trim()}":\n\n${results}\n\nNow complete your task.` });
      continue;
    }
    return response;
  }
  return callLlamaMessages(env, messages);
}

async function braveSearch(query, env) {
  if (!env.BRAVE_API_KEY) return "Web search unavailable — BRAVE_API_KEY not set.";
  try {
    const res  = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
      headers: { "Accept": "application/json", "X-Subscription-Token": env.BRAVE_API_KEY },
    });
    if (!res.ok) return `Search failed: HTTP ${res.status}`;
    const data = await res.json();
    const hits = data.web?.results || [];
    if (!hits.length) return "No results found.";
    return hits.slice(0, 5).map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.description || ""}`).join("\n\n");
  } catch (err) { return `Search error: ${err.message}`; }
}

// ─── Llama ────────────────────────────────────────────────────────

async function callLlamaMessages(env, messages, maxTokens = 1024) {
  const res = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages, max_tokens: maxTokens });
  return res.response || "";
}

async function callLlama(env, prompt, maxTokens = 1024) {
  return callLlamaMessages(env, [{ role: "user", content: prompt }], maxTokens);
}

// ─── R2 / KV helpers ─────────────────────────────────────────────

async function readTasks(env) {
  try { const o = await env.AGENT_BUCKET.get(R2.TASKS); return o ? JSON.parse(await o.text()) : []; } catch { return []; }
}
async function writeTasks(tasks, env) {
  await env.AGENT_BUCKET.put(R2.TASKS, JSON.stringify(tasks, null, 2));
}
async function readLog(env) {
  try { const o = await env.AGENT_BUCKET.get(R2.LOG); return o ? JSON.parse(await o.text()) : []; } catch { return []; }
}
async function readFile(key, env) {
  try { const o = await env.AGENT_BUCKET.get(key); return o ? await o.text() : defaultContent(key); } catch { return defaultContent(key); }
}
async function appendMemory(env, text) {
  const cur = await readFile(R2.MEMORY, env);
  await env.AGENT_BUCKET.put(R2.MEMORY, cur + "\n" + text);
}
function defaultContent(key) {
  if (key === R2.INSTRUCTIONS) return DEFAULT_INSTRUCTIONS;
  if (key === R2.MEMORY)       return DEFAULT_MEMORY;
  return "";
}

// ─── Utilities ────────────────────────────────────────────────────

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function taskId(path) { return path.split("/tasks/")[1]; }
function skipId(path, suffix) { return path.split("/tasks/")[1].replace(`/${suffix}`, ""); }

// ─── Defaults ─────────────────────────────────────────────────────

const DEFAULT_INSTRUCTIONS = `# Agent Instructions

## Identity
You are an autonomous AI agent running on Cloudflare Workers.
You execute daily tasks, reflect on results, and improve yourself over time.

## Behavior
- Be concise and factual in task outputs
- Always end task results with a LEARNING line
- When editing your own files, preserve structure and improve clarity
- Never delete memory — only append or refine

## Task Execution
- Read the task description carefully
- Use web search when current information is needed
- If uncertain, state your assumptions clearly

## Self-Improvement
- After each daily run, reflect on patterns across tasks
- Update memory with genuine insights, not filler

## Output Format
1. Summary (1-2 sentences)
2. Details (bullet points)
3. LEARNING: one-line insight
`;

const DEFAULT_MEMORY = `# Agent Memory

## Created
${new Date().toISOString()}

## Learnings
(Populated automatically after each daily run)

## Patterns Noticed
(Agent fills this in over time)
`;
