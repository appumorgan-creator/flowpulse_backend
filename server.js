import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

// CORS: allow Vercel frontend + localhost for dev
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.FRONTEND_URL, // set this in Render dashboard
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, mobile apps)
    if (!origin) return cb(null, true);
    // Allow any *.vercel.app during development
    if (origin.endsWith(".vercel.app") || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    cb(null, true); // permissive for now — tighten after launch
  },
}));
app.use(express.json());

const PORT = process.env.PORT || 3001;

// In-memory session store
const sessions = new Map();

// Health check for Render
app.get("/", (req, res) => {
  res.json({ 
    status: "ok", 
    service: "FlowPulse API",
    sessions: sessions.size,
    uptime: process.uptime(),
  });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ─── n8n API helper ───
async function n8nFetch(baseUrl, apiKey, endpoint, params) {
  let url = baseUrl.replace(/\/+$/, "");
  if (!url.includes("/api/v1")) url += "/api/v1";
  url += endpoint;

  const query = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) query.set(k, v);
    }
  }
  const qs = query.toString();
  if (qs) url += "?" + qs;

  const res = await fetch(url, {
    headers: { "X-N8N-API-KEY": apiKey, Accept: "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`n8n API ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

// Paginated fetch
async function n8nFetchAll(baseUrl, apiKey, endpoint, params = {}, maxPages = 20) {
  let all = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const p = { ...params, limit: 100 };
    if (cursor) p.cursor = cursor;
    const data = await n8nFetch(baseUrl, apiKey, endpoint, p);
    const items = data.data || [];
    all = all.concat(items);
    cursor = data.nextCursor;
    if (!cursor || items.length < 100) break;
  }
  return all;
}

// ─── Connect ───
app.post("/connect", async (req, res) => {
  try {
    const { instanceUrl, apiKey } = req.body;
    if (!instanceUrl || !apiKey) {
      return res.status(400).json({ success: false, error: "Missing instanceUrl or apiKey" });
    }
    // Test connection
    await n8nFetch(instanceUrl, apiKey, "/workflows", { limit: 1 });
    const sessionId = `fp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    sessions.set(sessionId, { instanceUrl, apiKey, connectedAt: new Date() });
    res.json({ success: true, sessionId });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

// ─── Middleware: require session ───
function requireSession(req, res, next) {
  const sid = req.headers["x-flowpulse-session"];
  if (!sid || !sessions.has(sid)) {
    return res.status(401).json({ error: "Invalid or missing session" });
  }
  req.n8n = sessions.get(sid);
  next();
}

// ─── Dashboard ───
app.get("/api/dashboard", requireSession, async (req, res) => {
  try {
    const { instanceUrl, apiKey } = req.n8n;

    const [workflows, executions] = await Promise.all([
      n8nFetchAll(instanceUrl, apiKey, "/workflows"),
      n8nFetchAll(instanceUrl, apiKey, "/executions", { includeData: false }),
    ]);

    // Build workflow name map
    const wfMap = {};
    workflows.forEach(w => { wfMap[w.id] = w.name; });

    // Process executions
    const enriched = executions.map(e => ({
      id: e.id,
      workflowId: e.workflowId,
      workflowName: wfMap[e.workflowId] || "Unknown",
      status: e.status === "success" ? "success" : "error",
      startedAt: e.startedAt,
      stoppedAt: e.stoppedAt,
      duration: e.startedAt && e.stoppedAt
        ? new Date(e.stoppedAt) - new Date(e.startedAt)
        : null,
      error: e.data?.resultData?.error?.message || null,
    }));

    // Sort by most recent
    enriched.sort((a, b) => {
      const ta = a.stoppedAt || a.startedAt || "";
      const tb = b.stoppedAt || b.startedAt || "";
      return tb.localeCompare(ta);
    });

    // Per-workflow stats
    const wfStats = {};
    enriched.forEach(e => {
      if (!wfStats[e.workflowId]) wfStats[e.workflowId] = { execs: 0, fails: 0, durations: [], recent: [] };
      wfStats[e.workflowId].execs++;
      if (e.status === "error") wfStats[e.workflowId].fails++;
      if (e.duration) wfStats[e.workflowId].durations.push(e.duration);
      if (wfStats[e.workflowId].recent.length < 1) wfStats[e.workflowId].recent.push(e);
    });

    // Sparklines (7 days)
    const now = Date.now();
    const dayMs = 86400000;

    const wfData = workflows.map(w => {
      const s = wfStats[w.id] || { execs: 0, fails: 0, durations: [], recent: [] };
      const sparkline = Array.from({ length: 7 }, (_, i) => {
        const dayStart = now - (6 - i) * dayMs;
        const dayEnd = dayStart + dayMs;
        return enriched.filter(e => {
          if (e.workflowId !== w.id) return false;
          const t = new Date(e.startedAt || e.stoppedAt).getTime();
          return t >= dayStart && t < dayEnd;
        }).length;
      });

      return {
        id: w.id,
        name: w.name,
        active: w.active,
        tags: (w.tags || []).map(t => typeof t === "string" ? t : t.name),
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        execCount: s.execs,
        failedCount: s.fails,
        successRate: s.execs > 0 ? ((1 - s.fails / s.execs) * 100).toFixed(0) : "100",
        sparkline,
        lastExec: s.recent[0] || null,
      };
    });

    // Overall stats
    const totalExecs = enriched.length;
    const failedExecs = enriched.filter(e => e.status === "error").length;
    const durations = enriched.filter(e => e.duration).map(e => e.duration);
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

    // Error grouping
    const errorGroups = {};
    enriched.filter(e => e.status === "error" && e.error).forEach(e => {
      const key = e.error.substring(0, 100);
      if (!errorGroups[key]) errorGroups[key] = { message: e.error, count: 0, workflows: new Set(), lastSeen: null };
      errorGroups[key].count++;
      errorGroups[key].workflows.add(e.workflowName);
      if (!errorGroups[key].lastSeen || e.stoppedAt > errorGroups[key].lastSeen) {
        errorGroups[key].lastSeen = e.stoppedAt;
      }
    });

    res.json({
      stats: {
        totalWorkflows: workflows.length,
        activeWorkflows: workflows.filter(w => w.active).length,
        totalExecs,
        failedExecs,
        successRate: totalExecs > 0 ? ((1 - failedExecs / totalExecs) * 100).toFixed(1) : "100",
        avgDuration,
      },
      workflows: wfData,
      executions: enriched,
      errors: Object.values(errorGroups)
        .map(g => ({ ...g, workflows: [...g.workflows] }))
        .sort((a, b) => b.count - a.count),
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Individual endpoints ───
app.get("/api/workflows", requireSession, async (req, res) => {
  try {
    const data = await n8nFetchAll(req.n8n.instanceUrl, req.n8n.apiKey, "/workflows");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/executions", requireSession, async (req, res) => {
  try {
    const data = await n8nFetchAll(req.n8n.instanceUrl, req.n8n.apiKey, "/executions", {
      includeData: false,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/executions/:id/retry", requireSession, async (req, res) => {
  try {
    const data = await n8nFetch(
      req.n8n.instanceUrl, req.n8n.apiKey,
      `/executions/${req.params.id}/retry`, null
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/disconnect", (req, res) => {
  const sid = req.headers["x-flowpulse-session"];
  if (sid) sessions.delete(sid);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\n⚡ FlowPulse API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
