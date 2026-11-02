// Vercel function: POST /api/drill dispatches the workflow; GET /api/drill?since=...
// reads its real GitHub Actions run status. KAIZEN_DISPATCH_TOKEN remains server-side.
const OWNER = 'Shaydez-Defi';
const REPO = 'kaizen';
const WORKFLOW = 'drill-live.yml';
const COOLDOWN_MS = 20 * 60 * 1000;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

function json(res, status, body) {
  return res.status(status).setHeader('cache-control', 'no-store').json(body);
}

function workflowRun(run) {
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    html_url: run.html_url,
    created_at: run.created_at,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { message: 'GET or POST only' });
  const token = process.env.KAIZEN_DISPATCH_TOKEN;
  if (!token) return json(res, 503, { message: 'On-demand drills are disabled until KAIZEN_DISPATCH_TOKEN is configured on the server.' });

  const github = async (path, init = {}) => fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'kaizen-live',
      ...(init.headers || {}),
    },
  });

  try {
    if (req.method === 'GET') {
      const since = typeof req.query?.since === 'string' && req.query.since.length <= 64 ? req.query.since : '';
      const sinceMs = Date.parse(since);
      if (!Number.isFinite(sinceMs)) return json(res, 400, { message: 'A valid since timestamp is required.' });
      const response = await github(`/actions/workflows/${WORKFLOW}/runs?per_page=10&event=workflow_dispatch`);
      if (!response.ok) return json(res, 502, { message: `GitHub status lookup failed (HTTP ${response.status}).` });
      const data = await response.json();
      const run = (data.workflow_runs || []).find((entry) => Date.parse(entry.created_at) >= sinceMs);
      return json(res, 200, { since, run: run ? workflowRun(run) : null });
    }

    const runsResponse = await github(`/actions/workflows/${WORKFLOW}/runs?per_page=5`);
    if (!runsResponse.ok) return json(res, 502, { message: `GitHub run check failed (HTTP ${runsResponse.status}).` });
    const data = await runsResponse.json();
    const list = data.workflow_runs || [];
    if (list.some((run) => run.status !== 'completed')) return json(res, 409, { message: 'A drill is already running. Watch the Live page for its status.' });
    const last = list[0];
    if (last && Date.now() - Date.parse(last.created_at) < COOLDOWN_MS) {
      const mins = Math.ceil((COOLDOWN_MS - (Date.now() - Date.parse(last.created_at))) / 60000);
      return json(res, 429, { message: `A drill ran recently. Try again in ${mins} min.` });
    }

    // Workflow run listing is eventually consistent. Cooldown guarantees no
    // prior dispatch can be mistaken for this one, so allow a short clock/API lag.
    const since = new Date(Date.now() - 60_000).toISOString();
    const dispatch = await github(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', inputs: { requested_by: 'live page' } }),
    });
    if (dispatch.status !== 204) return json(res, 502, { message: `GitHub refused the dispatch (HTTP ${dispatch.status}).` });
    return json(res, 202, { message: 'GitHub accepted the workflow dispatch. Waiting for the run to appear.', since, run: null });
  } catch {
    return json(res, 502, { message: 'Could not reach GitHub Actions. No workflow status is available.' });
  }
}
