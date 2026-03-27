import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const app = express();

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3001);
const dataFilePath =
  process.env.DATA_FILE || path.resolve(process.cwd(), 'data', 'dcim-layout.json');
const defaultViewId = process.env.DEFAULT_VIEW_ID || 'default';

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

app.listen(port, host, () => {
  console.log(`Layout persistence service listening on http://${host}:${port}`);
  console.log(`Data file: ${dataFilePath}`);
});
