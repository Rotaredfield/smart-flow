import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { exec as execCommand } from 'node:child_process';
import { promisify } from 'node:util';

const app = express();
const execAsync = promisify(execCommand);

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3001);
const dataFilePath =
  process.env.DATA_FILE || path.resolve(process.cwd(), 'data', 'dcim-layout.json');
const defaultViewId = process.env.DEFAULT_VIEW_ID || 'default';
const slurmSyncEnabled = process.env.SLURM_SYNC_ENABLED !== 'false';
const slurmStatusCommand = process.env.SLURM_NODE_STATUS_CMD || 'scontrol show nodes -o';
const slurmCommandTimeoutMs = Number(process.env.SLURM_NODE_STATUS_TIMEOUT_MS || 8000);
const slurmRefreshMs = Math.max(5000, Number(process.env.SLURM_REFRESH_MS || 15000));
const slurmMaintenanceKeyword = process.env.SLURM_MAINTENANCE_KEYWORD || '维护';

const withDefaultSshOptions = (command) => {
  const trimmed = String(command || '').trim();
  if (!trimmed.startsWith('ssh ')) return command;
  if (trimmed.includes('StrictHostKeyChecking') || trimmed.includes('UserKnownHostsFile')) {
    return command;
  }
  return trimmed.replace(
    /^ssh\s+/,
    'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '
  );
};

const effectiveSlurmStatusCommand = withDefaultSshOptions(slurmStatusCommand);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const createDefaultStore = () => ({
  version: 1,
  views: {},
});

const normalizeViewId = (rawViewId) => {
  if (typeof rawViewId !== 'string') return defaultViewId;
  const trimmed = rawViewId.trim();
  return trimmed.length > 0 ? trimmed : defaultViewId;
};

const safeArray = (value) => (Array.isArray(value) ? value : []);
const normalizeLookupKey = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const ensureStoreDir = async () => {
  await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
};

const readStore = async () => {
  try {
    const raw = await fs.readFile(dataFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return createDefaultStore();

    const views = parsed.views && typeof parsed.views === 'object' ? parsed.views : {};
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      views,
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return createDefaultStore();
    }
    throw error;
  }
};

const writeStore = async (store) => {
  await ensureStoreDir();
  const tempFilePath = `${dataFilePath}.tmp`;
  await fs.writeFile(tempFilePath, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tempFilePath, dataFilePath);
};

const NORMAL_SLURM_STATES = new Set([
  'IDLE',
  'ALLOCATED',
  'MIXED',
  'COMPLETING',
  'RESUME',
  'POWERING_UP',
  'PLANNED',
]);

const ABNORMAL_SLURM_STATES = new Set([
  'DOWN',
  'DRAIN',
  'DRAINED',
  'DRAINING',
  'FAIL',
  'FAILING',
  'NO_RESPOND',
  'UNKNOWN',
  'FUTURE',
  'INVAL',
  'MAINT',
  'POWERING_DOWN',
  'POWERED_DOWN',
  'REBOOT_REQUESTED',
  'REBOOT_ISSUED',
  'REBOOT_CANCEL',
  'CLOUD',
  'ERROR',
]);

const slurmStatusCache = {
  updatedAt: null,
  statuses: [],
  error: null,
  lastAttemptAt: null,
};

let slurmRefreshPromise = null;
let slurmIntervalId = null;

const readSimpleField = (line, key) => {
  const match = line.match(new RegExp(`\\b${key}=([^\\s]+)`));
  return match?.[1] || '';
};

const readPossiblySpacedField = (line, key) => {
  const fieldMatch = line.match(
    new RegExp(`\\b${key}=(.*?)(?=\\s+[A-Za-z][A-Za-z0-9_]*=|$)`)
  );
  return fieldMatch?.[1]?.trim() || '';
};

const decodeSlurmText = (value) => {
  if (!value) return '';
  return value.replace(/\\x20/g, ' ').replace(/_/g, ' ').trim();
};

const splitSlurmStateTokens = (rawState) =>
  String(rawState || '')
    .toUpperCase()
    .replace(/\*/g, '')
    .split(/[+,]/)
    .map((token) => token.replace(/[^A-Z_]/g, '').trim())
    .filter(Boolean);

const includesMaintenanceReason = (reason) => {
  const cleaned = String(reason || '').trim();
  if (!cleaned) return false;
  if (cleaned.includes(slurmMaintenanceKeyword)) return true;
  return /maint/i.test(cleaned);
};

const isAbnormalSlurmState = (tokens) => {
  if (!Array.isArray(tokens) || tokens.length === 0) return false;
  for (const token of tokens) {
    if (ABNORMAL_SLURM_STATES.has(token)) return true;
    if (token.startsWith('DRAIN')) return true;
    if (token.startsWith('FAIL')) return true;
    if (!NORMAL_SLURM_STATES.has(token)) return true;
  }
  return false;
};

const mapSlurmStateToStatus = (rawState, reason) => {
  const tokens = splitSlurmStateTokens(rawState);
  const hasDrainState = tokens.some((token) => token.startsWith('DRAIN'));
  if (hasDrainState && includesMaintenanceReason(reason)) {
    return 'maintenance';
  }
  if (isAbnormalSlurmState(tokens)) {
    return 'malfunction';
  }
  return 'active';
};

const parseSlurmNodesFromOutput = (stdout) => {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const nodes = [];

  for (const line of lines) {
    const nodeName = decodeSlurmText(readSimpleField(line, 'NodeName'));
    if (!nodeName) continue;

    const nodeAddr = decodeSlurmText(readSimpleField(line, 'NodeAddr'));
    const rawState = decodeSlurmText(readSimpleField(line, 'State'));
    const reason = decodeSlurmText(readPossiblySpacedField(line, 'Reason'));
    const status = mapSlurmStateToStatus(rawState, reason);

    nodes.push({
      nodeName,
      nodeAddr: nodeAddr || null,
      state: rawState || '',
      reason: reason || '',
      status,
      keys: [nodeName, nodeAddr].map(normalizeLookupKey).filter(Boolean),
    });
  }

  return nodes;
};

const refreshSlurmStatusCache = async () => {
  if (!slurmSyncEnabled) return;

  slurmStatusCache.lastAttemptAt = new Date().toISOString();

  const { stdout } = await execAsync(effectiveSlurmStatusCommand, {
    timeout: slurmCommandTimeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });

  const parsedNodes = parseSlurmNodesFromOutput(stdout);
  slurmStatusCache.statuses = parsedNodes;
  slurmStatusCache.updatedAt = new Date().toISOString();
  slurmStatusCache.error = null;
};

const ensureSlurmStatusCacheReady = async () => {
  if (!slurmSyncEnabled) return;
  if (slurmRefreshPromise) {
    await slurmRefreshPromise;
    return;
  }

  const shouldRefresh =
    !slurmStatusCache.updatedAt ||
    Date.now() - Date.parse(slurmStatusCache.updatedAt) > slurmRefreshMs;

  if (!shouldRefresh) return;

  slurmRefreshPromise = refreshSlurmStatusCache()
    .catch((error) => {
      const message =
        error && typeof error === 'object' && 'message' in error
          ? String(error.message)
          : 'Unknown Slurm status error';
      slurmStatusCache.error = message;
      console.error('Failed to refresh Slurm node statuses:', error);
    })
    .finally(() => {
      slurmRefreshPromise = null;
    });

  await slurmRefreshPromise;
};

if (slurmSyncEnabled) {
  ensureSlurmStatusCacheReady().catch((error) => {
    console.error('Initial Slurm status refresh failed:', error);
  });

  slurmIntervalId = setInterval(() => {
    ensureSlurmStatusCacheReady().catch((error) => {
      console.error('Scheduled Slurm status refresh failed:', error);
    });
  }, slurmRefreshMs);

  if (typeof slurmIntervalId.unref === 'function') {
    slurmIntervalId.unref();
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/layout', async (req, res) => {
  try {
    const viewId = normalizeViewId(req.query.viewId);
    const store = await readStore();
    const view = store.views[viewId];

    if (!view) {
      return res.json({
        viewId,
        nodes: [],
        edges: [],
        updatedAt: null,
      });
    }

    return res.json({
      viewId,
      nodes: safeArray(view.nodes),
      edges: safeArray(view.edges),
      updatedAt: typeof view.updatedAt === 'string' ? view.updatedAt : null,
    });
  } catch (error) {
    console.error('Failed to read layout:', error);
    return res.status(500).json({ message: 'Failed to read layout data.' });
  }
});

app.put('/api/layout', async (req, res) => {
  try {
    const viewId = normalizeViewId(req.query.viewId || req.body?.viewId);
    const nodes = safeArray(req.body?.nodes);
    const edges = safeArray(req.body?.edges);

    const store = await readStore();
    const updatedAt = new Date().toISOString();

    store.views[viewId] = {
      nodes,
      edges,
      updatedAt,
    };

    await writeStore(store);

    return res.json({
      ok: true,
      viewId,
      updatedAt,
    });
  } catch (error) {
    console.error('Failed to write layout:', error);
    return res.status(500).json({ message: 'Failed to persist layout data.' });
  }
});

app.get('/api/slurm/status', async (_req, res) => {
  try {
    if (!slurmSyncEnabled) {
      return res.json({
        enabled: false,
        updatedAt: null,
        statuses: [],
        error: null,
      });
    }

    await ensureSlurmStatusCacheReady();

    return res.json({
      enabled: true,
      updatedAt: slurmStatusCache.updatedAt,
      statuses: safeArray(slurmStatusCache.statuses),
      error: slurmStatusCache.error,
      command: effectiveSlurmStatusCommand,
      maintenanceKeyword: slurmMaintenanceKeyword,
    });
  } catch (error) {
    console.error('Failed to return Slurm statuses:', error);
    return res.status(500).json({ message: 'Failed to query Slurm statuses.' });
  }
});

app.listen(port, host, () => {
  console.log(`Layout persistence service listening on http://${host}:${port}`);
  console.log(`Data file: ${dataFilePath}`);
  if (slurmSyncEnabled) {
    console.log(`Slurm status sync enabled (refresh ${slurmRefreshMs}ms).`);
    console.log(`Slurm command: ${effectiveSlurmStatusCommand}`);
  } else {
    console.log('Slurm status sync disabled.');
  }
});
