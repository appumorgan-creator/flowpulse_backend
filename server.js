import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors({ origin: (o, cb) => cb(null, true) }));
app.use(express.json());

const PORT = process.env.PORT || 3001;
const sessions = new Map();

// ─── Health ───
app.get("/", (req, res) => res.json({ status: "ok", service: "FlowPulse API v2", sessions: sessions.size, uptime: process.uptime() }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ─── n8n API helpers ───
async function n8nFetch(baseUrl, apiKey, endpoint, params) {
  let url = baseUrl.replace(/\/+$/, "");
  if (!url.includes("/api/v1")) url += "/api/v1";
  url += endpoint;
  const query = new URLSearchParams();
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) query.set(k, v);
  const qs = query.toString();
  if (qs) url += "?" + qs;
  const res = await fetch(url, { headers: { "X-N8N-API-KEY": apiKey, Accept: "application/json" } });
  if (!res.ok) { const t = await res.text(); throw new Error(`n8n ${res.status}: ${t.substring(0, 200)}`); }
  return res.json();
}

async function n8nFetchAll(baseUrl, apiKey, endpoint, params = {}, maxPages = 20) {
  let all = [], cursor = null;
  for (let i = 0; i < maxPages; i++) {
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
    const { instanceUrl, apiKey, slackWebhook } = req.body;
    if (!instanceUrl || !apiKey) return res.status(400).json({ success: false, error: "Missing instanceUrl or apiKey" });
    await n8nFetch(instanceUrl, apiKey, "/workflows", { limit: 1 });
    const sessionId = `fp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    sessions.set(sessionId, { instanceUrl, apiKey, slackWebhook: slackWebhook || null, connectedAt: new Date(), alertsSent: 0 });
    res.json({ success: true, sessionId });
  } catch (err) { res.status(401).json({ success: false, error: err.message }); }
});

// ─── Update Slack webhook ───
app.post("/api/slack-config", requireSession, (req, res) => {
  const { slackWebhook } = req.body;
  req.n8n.slackWebhook = slackWebhook || null;
  res.json({ success: true, configured: !!slackWebhook });
});

// ─── Slack alert sender ───
async function sendSlackAlert(session, workflow, execution) {
  if (!session.slackWebhook) return;
  try {
    const payload = {
      blocks: [
        { type: "header", text: { type: "plain_text", text: "🔴 FlowPulse Alert: Workflow Failed" } },
        { type: "section", fields: [
          { type: "mrkdwn", text: `*Workflow:*\n${workflow.name || "Unknown"}` },
          { type: "mrkdwn", text: `*Status:*\n❌ Failed` },
          { type: "mrkdwn", text: `*Execution ID:*\n#${execution.id}` },
          { type: "mrkdwn", text: `*Time:*\n${new Date(execution.stoppedAt || execution.startedAt).toLocaleString()}` },
        ]},
        ...(execution.error ? [{ type: "section", text: { type: "mrkdwn", text: `*Error:*\n\`\`\`${execution.error.substring(0, 500)}\`\`\`` } }] : []),
        { type: "context", elements: [{ type: "mrkdwn", text: `Sent by FlowPulse | ${session.instanceUrl}` }] },
      ],
    };
    await fetch(session.slackWebhook, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    session.alertsSent = (session.alertsSent || 0) + 1;
  } catch (e) { console.error("Slack alert failed:", e.message); }
}

// ─── Session middleware ───
function requireSession(req, res, next) {
  const sid = req.headers["x-flowpulse-session"];
  if (!sid || !sessions.has(sid)) return res.status(401).json({ error: "Invalid session" });
  req.n8n = sessions.get(sid);
  next();
}

// ─── Enhanced Dashboard ───
app.get("/api/dashboard", requireSession, async (req, res) => {
  try {
    const { instanceUrl, apiKey } = req.n8n;
    const [workflows, executions] = await Promise.all([
      n8nFetchAll(instanceUrl, apiKey, "/workflows"),
      n8nFetchAll(instanceUrl, apiKey, "/executions", { includeData: false }),
    ]);

    const wfMap = {};
    workflows.forEach(w => { wfMap[w.id] = w; });

    const enriched = executions.map(e => ({
      id: e.id,
      workflowId: e.workflowId,
      workflowName: wfMap[e.workflowId]?.name || "Unknown",
      status: e.status === "success" ? "success" : "error",
      startedAt: e.startedAt,
      stoppedAt: e.stoppedAt,
      duration: e.startedAt && e.stoppedAt ? new Date(e.stoppedAt) - new Date(e.startedAt) : null,
      error: e.data?.resultData?.error?.message || null,
      mode: e.mode || "unknown",
    }));
    enriched.sort((a, b) => (b.stoppedAt || b.startedAt || "").localeCompare(a.stoppedAt || a.startedAt || ""));

    // Per-workflow stats
    const wfStats = {};
    enriched.forEach(e => {
      if (!wfStats[e.workflowId]) wfStats[e.workflowId] = { execs: 0, fails: 0, durations: [], errors: [], recent: [], hourly: {} };
      const s = wfStats[e.workflowId];
      s.execs++;
      if (e.status === "error") { s.fails++; if (e.error) s.errors.push(e.error.substring(0, 150)); }
      if (e.duration) s.durations.push(e.duration);
      if (s.recent.length < 20) s.recent.push(e);
      // Hourly distribution
      if (e.startedAt) {
        const h = new Date(e.startedAt).getHours();
        s.hourly[h] = (s.hourly[h] || 0) + 1;
      }
    });

    const now = Date.now();
    const dayMs = 86400000;

    const wfData = workflows.map(w => {
      const s = wfStats[w.id] || { execs: 0, fails: 0, durations: [], errors: [], recent: [], hourly: {} };
      const avgDur = s.durations.length > 0 ? Math.round(s.durations.reduce((a, b) => a + b, 0) / s.durations.length) : 0;
      const p95Dur = s.durations.length > 0 ? s.durations.sort((a, b) => a - b)[Math.floor(s.durations.length * 0.95)] : 0;
      const sparkline = Array.from({ length: 7 }, (_, i) => {
        const dayStart = now - (6 - i) * dayMs;
        const dayEnd = dayStart + dayMs;
        return enriched.filter(e => e.workflowId === w.id && e.startedAt && new Date(e.startedAt).getTime() >= dayStart && new Date(e.startedAt).getTime() < dayEnd).length;
      });
      // Weekly duration trend (5 weeks)
      const durationTrend = Array.from({ length: 5 }, (_, i) => {
        const weekStart = now - (4 - i) * 7 * dayMs;
        const weekEnd = weekStart + 7 * dayMs;
        const weekDurations = enriched
          .filter(e => e.workflowId === w.id && e.duration && e.startedAt && new Date(e.startedAt).getTime() >= weekStart && new Date(e.startedAt).getTime() < weekEnd)
          .map(e => e.duration);
        return {
          avg: weekDurations.length > 0 ? Math.round(weekDurations.reduce((a, b) => a + b, 0) / weekDurations.length) : 0,
          p95: weekDurations.length > 0 ? weekDurations.sort((a, b) => a - b)[Math.floor(weekDurations.length * 0.95)] : 0,
          count: weekDurations.length,
        };
      });
      // Top error messages
      const errorCounts = {};
      s.errors.forEach(e => { errorCounts[e] = (errorCounts[e] || 0) + 1; });
      const topErrors = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([msg, count]) => ({ message: msg, count }));

      return {
        id: w.id, name: w.name, active: w.active,
        tags: (w.tags || []).map(t => typeof t === "string" ? t : t.name),
        createdAt: w.createdAt, updatedAt: w.updatedAt,
        nodeCount: w.nodes?.length || 0,
        nodes: (w.nodes || []).map(n => ({ type: n.type, name: n.name })).slice(0, 30),
        execCount: s.execs, failedCount: s.fails,
        successRate: s.execs > 0 ? ((1 - s.fails / s.execs) * 100).toFixed(0) : "100",
        avgDuration: avgDur, p95Duration: p95Dur,
        sparkline, durationTrend, topErrors,
        hourlyDistribution: s.hourly,
        recentExecutions: s.recent,
        lastExec: s.recent[0] || null,
      };
    });

    // Hourly heatmap (7 days x 24 hours)
    const heatmap = [];
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const dayStart = now - (6 - d) * dayMs;
        const dayEnd = dayStart + dayMs;
        const dayExecs = enriched.filter(e => {
          if (!e.startedAt) return false;
          const t = new Date(e.startedAt);
          return t.getTime() >= dayStart && t.getTime() < dayEnd && t.getHours() === h;
        });
        heatmap.push({
          day: dayNames[new Date(dayStart).getDay()],
          di: d, h,
          total: dayExecs.length,
          failures: dayExecs.filter(e => e.status === "error").length,
        });
      }
    }

    // Overall
    const totalExecs = enriched.length;
    const failedExecs = enriched.filter(e => e.status === "error").length;
    const allDurations = enriched.filter(e => e.duration).map(e => e.duration);
    const avgDuration = allDurations.length > 0 ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length) : 0;

    // Error grouping
    const errorGroups = {};
    enriched.filter(e => e.status === "error" && e.error).forEach(e => {
      const key = e.error.substring(0, 100);
      if (!errorGroups[key]) errorGroups[key] = { message: e.error, count: 0, workflows: new Set(), lastSeen: null };
      errorGroups[key].count++;
      errorGroups[key].workflows.add(e.workflowName);
      if (!errorGroups[key].lastSeen || e.stoppedAt > errorGroups[key].lastSeen) errorGroups[key].lastSeen = e.stoppedAt;
    });

    // Check for new failures and send Slack alerts
    const recentFailures = enriched.filter(e => {
      if (e.status !== "error") return false;
      const t = new Date(e.stoppedAt || e.startedAt).getTime();
      return t > now - 60000; // Last 60 seconds
    });
    for (const fail of recentFailures.slice(0, 3)) {
      await sendSlackAlert(req.n8n, wfMap[fail.workflowId] || { name: fail.workflowName }, fail);
    }

    res.json({
      stats: { totalWorkflows: workflows.length, activeWorkflows: workflows.filter(w => w.active).length, totalExecs, failedExecs, successRate: totalExecs > 0 ? ((1 - failedExecs / totalExecs) * 100).toFixed(1) : "100", avgDuration },
      workflows: wfData,
      executions: enriched.slice(0, 200),
      heatmap,
      errors: Object.values(errorGroups).map(g => ({ ...g, workflows: [...g.workflows] })).sort((a, b) => b.count - a.count),
      slackConfigured: !!req.n8n.slackWebhook,
      alertsSent: req.n8n.alertsSent || 0,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Retry execution ───
app.post("/api/executions/:id/retry", requireSession, async (req, res) => {
  try {
    const data = await n8nFetch(req.n8n.instanceUrl, req.n8n.apiKey, `/executions/${req.params.id}/retry`);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Activate/Deactivate workflow ───
app.patch("/api/workflows/:id", requireSession, async (req, res) => {
  try {
    const { active } = req.body;
    let url = req.n8n.instanceUrl.replace(/\/+$/, "");
    if (!url.includes("/api/v1")) url += "/api/v1";
    url += `/workflows/${req.params.id}`;
    const r = await fetch(url, {
      method: "PATCH",
      headers: { "X-N8N-API-KEY": req.n8n.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    if (!r.ok) throw new Error(`n8n ${r.status}`);
    res.json({ success: true, active });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Disconnect ───
app.post("/disconnect", (req, res) => {
  const sid = req.headers["x-flowpulse-session"];
  if (sid) sessions.delete(sid);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`⚡ FlowPulse API v2 on port ${PORT}`));
