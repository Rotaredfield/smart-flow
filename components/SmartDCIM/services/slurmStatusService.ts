import type { ServerData } from '../types';

const RAW_API_BASE = import.meta.env.VITE_API_BASE || '/api';
const API_BASE = RAW_API_BASE.endsWith('/') ? RAW_API_BASE.slice(0, -1) : RAW_API_BASE;
const SLURM_STATUS_URL = `${API_BASE}/slurm/status`;

export interface SlurmNodeStatus {
  nodeName: string;
  nodeAddr?: string | null;
  state: string;
  reason?: string;
  status: ServerData['status'];
  keys?: string[];
}

export interface SlurmStatusResponse {
  enabled: boolean;
  updatedAt: string | null;
  statuses: SlurmNodeStatus[];
  error: string | null;
}

const toSlurmNodeStatusArray = (value: unknown): SlurmNodeStatus[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === 'object') as SlurmNodeStatus[];
};

export const loadSlurmStatuses = async (): Promise<SlurmStatusResponse> => {
  const response = await fetch(SLURM_STATUS_URL, {
    method: 'GET',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Load Slurm status failed: ${response.status}`);
  }

  const payload = await response.json();

  return {
    enabled: payload?.enabled !== false,
    updatedAt: typeof payload?.updatedAt === 'string' ? payload.updatedAt : null,
    statuses: toSlurmNodeStatusArray(payload?.statuses),
    error: typeof payload?.error === 'string' ? payload.error : null,
  };
};
