import type { Edge, Node } from 'reactflow';

const RAW_API_BASE = import.meta.env.VITE_API_BASE || '/api';
const API_BASE = RAW_API_BASE.endsWith('/') ? RAW_API_BASE.slice(0, -1) : RAW_API_BASE;

export const DEFAULT_VIEW_ID = 'default';

export interface PersistedLayout {
  nodes: Node[];
  edges: Edge[];
  updatedAt?: string | null;
}

const getLayoutUrl = (viewId: string = DEFAULT_VIEW_ID) =>
  `${API_BASE}/layout?viewId=${encodeURIComponent(viewId)}`;

export const loadLayout = async (viewId: string = DEFAULT_VIEW_ID): Promise<PersistedLayout> => {
  const response = await fetch(getLayoutUrl(viewId), {
    method: 'GET',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Load layout failed: ${response.status}`);
  }

  const payload = await response.json();
  return {
    nodes: Array.isArray(payload?.nodes) ? payload.nodes : [],
    edges: Array.isArray(payload?.edges) ? payload.edges : [],
    updatedAt: typeof payload?.updatedAt === 'string' ? payload.updatedAt : null,
  };
};

export const saveLayout = async (
  layout: { nodes: Node[]; edges: Edge[] },
  viewId: string = DEFAULT_VIEW_ID
): Promise<void> => {
  const response = await fetch(getLayoutUrl(viewId), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      viewId,
      nodes: layout.nodes,
      edges: layout.edges,
    }),
  });

  if (!response.ok) {
    throw new Error(`Save layout failed: ${response.status}`);
  }
};
