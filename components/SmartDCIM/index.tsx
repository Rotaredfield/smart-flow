
import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import ReactFlow, {
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  ControlButton,
  Background,
  Connection,
  Edge,
  Node,
  useReactFlow,
  Panel,
  ReactFlowInstance,
  NodeDragHandler,
  BackgroundVariant,
  MiniMap,
  MarkerType,
  XYPosition
} from 'reactflow';

import Sidebar from './Sidebar';
import RackNode from './nodes/RackNode';
import ServerNode from './nodes/ServerNode';
import ZoneNode from './nodes/ZoneNode';
import SoftwareNode from './nodes/SoftwareNode';
import UdfNode from './nodes/UdfNode';
import PortConnectionEdge from '../edges/PortConnectionEdge';
import GeminiAdvisor from './GeminiAdvisor';
import NodeDetailsPanel from './NodeDetailsPanel';
import EdgeDetailsPanel from './EdgeDetailsPanel';
import ContextMenu from './ContextMenu';
import VisibilityControls from './VisibilityControls';
import { DragItem, ItemType, ServerData } from './types';
import { PX_PER_U, RACK_PADDING_PX, RACK_WIDTH_PX, SERVER_WIDTH_PX, RACK_TWO_COLUMN_GAP_PX, TOWER_SERVER_WIDTH_PX, RACK_HEADER_HEIGHT_PX, UDF_WIDTH_PX, UDF_HEIGHT_PX, DEFAULT_FIBER_PORTS, DEFAULT_NETWORK_PORTS, DEFAULT_TOWER_SERVER_U } from './constants';
import { DEFAULT_VIEW_ID, loadLayout, saveLayout } from './services/layoutPersistenceService';
import { loadSlurmStatuses, SlurmNodeStatus } from './services/slurmStatusService';

// --- Error Suppression Logic (Moved from root index.tsx) ---
const resizeErrorMessages = [
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop limit exceeded'
];

if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    if (resizeErrorMessages.some(msg => e.message.includes(msg))) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  });

  const originalConsoleError = console.error;
  console.error = (...args: any[]) => {
    const firstArg = args[0];
    if (
      (typeof firstArg === 'string' && resizeErrorMessages.some(msg => firstArg.includes(msg))) ||
      (firstArg instanceof Error && resizeErrorMessages.some(msg => firstArg.message.includes(msg)))
    ) {
      return;
    }
    originalConsoleError.apply(console, args);
  };
}

// Register custom nodes and edges
const nodeTypes = {
  rack: RackNode,
  placeholder: RackNode,
  server: ServerNode,
  tower_server: ServerNode,
  network: ServerNode,
  storage: ServerNode,
  firewall: ServerNode,
  virtual_machine: ServerNode,
  zone: ZoneNode,
  software: SoftwareNode,
  udf: UdfNode,
};

const edgeTypes = {
  portConnection: PortConnectionEdge,
};

// Z-Index Layers
const Z_INDEX_ZONE = -10;
const Z_INDEX_RACK = 0;
const Z_INDEX_DEVICE = 1000;
const AUTOSAVE_DELAY_MS = 700;
const HISTORY_LIMIT = 100;
const HISTORY_GROUP_DELAY_MS = 250;
const SLURM_SYNC_INTERVAL_MS = Math.max(5000, Number(import.meta.env.VITE_SLURM_REFRESH_MS || 15000));
const SLURM_SYNC_NODE_TYPES = new Set([ItemType.SERVER, ItemType.TOWER_SERVER]);
const TRANSIENT_NODE_DATA_FIELDS = [
  'isMatchedType',
  'isDropTarget',
  'previewUPosition',
  'previewUHeight',
  'isSearchMatch',
  'isCurrentSearchMatch',
  'runtimeStatus',
  'runtimeStatusReason',
  'runtimeStatusSource',
  'slurmNodeName',
  'slurmState'
];

let id = 0;
const getId = () => `dnd_${id++}_${Date.now()}`;

// MiniMap node color helper
const nodeColor = (node: Node) => {
  if (node.type === ItemType.ZONE) return '#e0e7ff';
  if (node.type === ItemType.RACK) return '#64748b';
  if (node.type === ItemType.PLACEHOLDER) return '#94a3b8';
  if (node.type === ItemType.NETWORK) return '#6366f1';
  if (node.type === ItemType.FIREWALL) return '#f97316';
  if (node.type === ItemType.STORAGE) return '#06b6d4';
  if (node.type === ItemType.VIRTUAL_MACHINE) return '#a855f7';
  if (node.type === ItemType.SOFTWARE) return '#ec4899';
  if (node.type === ItemType.UDF) return '#14b8a6';
  return '#10b981';
};

// --- HELPER FUNCTIONS FOR COLLISION ---

const getAbsolutePosition = (node: Node, allNodes: Node[]): XYPosition => {
    if (!node.parentId) return node.position;
    const parent = allNodes.find(n => n.id === node.parentId);
    if (parent) {
        // Recursive call in case of multi-level nesting (Server -> Rack -> Zone)
        const parentPos = getAbsolutePosition(parent, allNodes);
        return {
            x: parentPos.x + node.position.x,
            y: parentPos.y + node.position.y
        };
    }
    return node.position;
};

const checkCollision = (rect1: any, rect2: any) => {
    return (
        rect1.x < rect2.x + rect2.width &&
        rect1.x + rect1.width > rect2.x &&
        rect1.y < rect2.y + rect2.height &&
        rect1.y + rect1.height > rect2.y
    );
};

const getTowerColumnX = (column: number) =>
  RACK_PADDING_PX + column * (TOWER_SERVER_WIDTH_PX + RACK_TWO_COLUMN_GAP_PX);

const getTowerColumnForRackDrop = (nodeAbsX: number, rackAbsX: number) => {
  const nodeCenterX = nodeAbsX + (TOWER_SERVER_WIDTH_PX / 2);
  const splitLineX = rackAbsX + RACK_PADDING_PX + TOWER_SERVER_WIDTH_PX + (RACK_TWO_COLUMN_GAP_PX / 2);
  return nodeCenterX >= splitLineX ? 1 : 0;
};

const getTowerColumnFromRackChild = (node: Node) => {
  const rightColumnStart = getTowerColumnX(1);
  const nodeX = typeof node.position?.x === 'number' ? node.position.x : RACK_PADDING_PX;
  return nodeX >= rightColumnStart - 1 ? 1 : 0;
};

const sanitizeNodesForPersistence = (nodes: Node[]) =>
  nodes.map((node) => {
    const nextNode = { ...node, selected: false, dragging: false };
    if (node.data && typeof node.data === 'object' && !Array.isArray(node.data)) {
      const nextData = { ...(node.data as Record<string, unknown>) };
      TRANSIENT_NODE_DATA_FIELDS.forEach((field) => {
        delete nextData[field];
      });
      return { ...nextNode, data: nextData };
    }
    return nextNode;
  });

const sanitizeEdgesForPersistence = (edges: Edge[]) =>
  edges.map((edge) => ({ ...edge, selected: false }));

const serializeLayoutSnapshot = (nodes: Node[], edges: Edge[]) =>
  JSON.stringify({
    nodes: sanitizeNodesForPersistence(nodes),
    edges: sanitizeEdgesForPersistence(edges),
  });

const isTextEditingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true;
  }
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
};

const normalizeLookupKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const sanitizeNodeIdForLookup = (id: string) => {
  const normalized = normalizeLookupKey(id);
  if (!normalized) return null;
  if (normalized.startsWith('dnd_')) return null;
  return normalized;
};

const collectNodeLookupKeys = (node: Node): string[] => {
  const data = (node.data || {}) as Partial<ServerData>;
  const ipKey = normalizeLookupKey(data.ip);
  if (ipKey) {
    // Prefer strict IP binding whenever IP exists to avoid accidental fallback mismatches.
    return [ipKey];
  }

  const keys = new Set<string>();

  const maybePush = (value: unknown) => {
    const key = normalizeLookupKey(value);
    if (key) keys.add(key);
  };

  maybePush(data.slurmNodeName);
  maybePush(data.label);
  const normalizedNodeId = sanitizeNodeIdForLookup(node.id);
  if (normalizedNodeId) keys.add(normalizedNodeId);

  return Array.from(keys);
};

const buildSlurmStatusLookup = (statuses: SlurmNodeStatus[]) => {
  const lookup = new Map<string, SlurmNodeStatus>();

  statuses.forEach((item) => {
    const candidateKeys = Array.isArray(item.keys) ? item.keys : [item.nodeName, item.nodeAddr];
    candidateKeys
      .map((key) => normalizeLookupKey(key))
      .filter((key): key is string => Boolean(key))
      .forEach((key) => {
        if (!lookup.has(key)) {
          lookup.set(key, item);
        }
      });
  });

  return lookup;
};

const stripRuntimeStatusFields = (nodeData: Record<string, unknown>) => {
  const nextData = { ...nodeData };
  delete nextData.runtimeStatus;
  delete nextData.runtimeStatusReason;
  delete nextData.runtimeStatusSource;
  delete nextData.slurmNodeName;
  delete nextData.slurmState;
  return nextData;
};

const DCIMCanvas = () => {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  
  // Theme State
  const [isDark, setIsDark] = useState(true);

  // Selection State
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  
  const [isEditingNode, setIsEditingNode] = useState(false);
  const [activeType, setActiveType] = useState<ItemType | null>(null);
  const [showHelp, setShowHelp] = useState(true);
  
  // Highlight/Drag State
  const [isHighlightActive, setIsHighlightActive] = useState(false);
  const [targetRackId, setTargetRackId] = useState<string | null>(null);

  // Drag State for Revert
  const dragStartNodeRef = useRef<Node | null>(null);
  const saveTimeoutRef = useRef<number | null>(null);
  const lastPersistedSnapshotRef = useRef<string>('');
  const historyCommitTimeoutRef = useRef<number | null>(null);
  const undoStackRef = useRef<string[]>([]);
  const currentHistorySnapshotRef = useRef<string>('');
  const pendingHistoryBaseRef = useRef<string | null>(null);
  const pendingHistoryNextRef = useRef<string | null>(null);
  const isApplyingHistoryRef = useRef(false);
  const [isLayoutReady, setIsLayoutReady] = useState(false);

  // Use ReactFlow hook for internal state access
  const { project, getNodes, fitView } = useReactFlow();

  // Context Menu State
  const [menu, setMenu] = useState<{ id: string; top: number; left: number } | null>(null);

  // Space Key State for Panning
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  // Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<Node[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);

  const visibleEdges = useMemo(() => {
    if (selectedNode) {
      return edges.filter(
        (edge) => edge.source === selectedNode.id || edge.target === selectedNode.id
      );
    }
    if (selectedEdge) {
      return edges.filter((edge) => edge.id === selectedEdge.id);
    }
    return [];
  }, [edges, selectedEdge, selectedNode]);

  useEffect(() => {
    if (!selectedEdge) return;
    const latestSelectedEdge = edges.find((edge) => edge.id === selectedEdge.id);
    if (!latestSelectedEdge) {
      setSelectedEdge(null);
      return;
    }
    if (latestSelectedEdge !== selectedEdge) {
      setSelectedEdge(latestSelectedEdge);
    }
  }, [edges, selectedEdge]);

  // Import callback
  const handleImportComplete = useCallback(() => {
      setTimeout(() => {
          const currentNodes = getNodes();
          if (currentNodes.length > 0) {
              fitView({ 
                  padding: 0.3, 
                  duration: 800,
                  maxZoom: 1,
                  minZoom: 0.1
              });
          }
      }, 100);
  }, [getNodes, fitView]);

  const flushPendingHistoryEntry = useCallback(() => {
    if (historyCommitTimeoutRef.current !== null) {
      window.clearTimeout(historyCommitTimeoutRef.current);
      historyCommitTimeoutRef.current = null;
    }

    const baseSnapshot = pendingHistoryBaseRef.current;
    const nextSnapshot = pendingHistoryNextRef.current;

    if (baseSnapshot && nextSnapshot && baseSnapshot !== nextSnapshot) {
      undoStackRef.current.push(baseSnapshot);
      if (undoStackRef.current.length > HISTORY_LIMIT) {
        undoStackRef.current.splice(0, undoStackRef.current.length - HISTORY_LIMIT);
      }
    }

    pendingHistoryBaseRef.current = null;
    pendingHistoryNextRef.current = null;
  }, []);

  const handleUndo = useCallback(() => {
    if (!isLayoutReady) return;

    flushPendingHistoryEntry();

    const previousSnapshot = undoStackRef.current.pop();
    if (!previousSnapshot) return;

    try {
      const parsed = JSON.parse(previousSnapshot) as { nodes: Node[]; edges: Edge[] };
      isApplyingHistoryRef.current = true;
      currentHistorySnapshotRef.current = previousSnapshot;
      pendingHistoryBaseRef.current = null;
      pendingHistoryNextRef.current = null;
      setNodes(parsed.nodes);
      setEdges(parsed.edges);
      setSelectedNode(null);
      setSelectedEdge(null);
      setMenu(null);
      setIsEditingNode(false);
      setTargetRackId(null);
    } catch (error) {
      console.error('Failed to restore undo snapshot:', error);
    }
  }, [flushPendingHistoryEntry, isLayoutReady, setEdges, setNodes]);

  const applySlurmRuntimeStatuses = useCallback(
    (statuses: SlurmNodeStatus[]) => {
      const statusLookup = buildSlurmStatusLookup(statuses);

      setNodes((nds) => {
        let hasChanges = false;
        const nextNodes = nds.map((node) => {
          if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)) {
            return node;
          }

          const currentData = node.data as Record<string, unknown>;
          const hasRuntimeStatus =
            'runtimeStatus' in currentData ||
            'runtimeStatusReason' in currentData ||
            'runtimeStatusSource' in currentData ||
            'slurmNodeName' in currentData ||
            'slurmState' in currentData;

          if (!SLURM_SYNC_NODE_TYPES.has(node.type as ItemType)) {
            if (!hasRuntimeStatus) return node;
            hasChanges = true;
            return { ...node, data: stripRuntimeStatusFields(currentData) };
          }

          const matchedStatus = collectNodeLookupKeys(node)
            .map((key) => statusLookup.get(key))
            .find((value): value is SlurmNodeStatus => Boolean(value));

          if (!matchedStatus) {
            if (!hasRuntimeStatus) return node;
            hasChanges = true;
            return { ...node, data: stripRuntimeStatusFields(currentData) };
          }

          const nextRuntimeStatus = matchedStatus.status;
          const nextReason = matchedStatus.reason || '';
          const nextSlurmState = matchedStatus.state || '';
          const nextNodeName = matchedStatus.nodeName || '';

          if (
            currentData.runtimeStatus === nextRuntimeStatus &&
            currentData.runtimeStatusReason === nextReason &&
            currentData.runtimeStatusSource === 'slurm' &&
            currentData.slurmNodeName === nextNodeName &&
            currentData.slurmState === nextSlurmState
          ) {
            return node;
          }

          hasChanges = true;
          return {
            ...node,
            data: {
              ...currentData,
              runtimeStatus: nextRuntimeStatus,
              runtimeStatusReason: nextReason,
              runtimeStatusSource: 'slurm',
              slurmNodeName: nextNodeName,
              slurmState: nextSlurmState,
            },
          };
        });

        return hasChanges ? nextNodes : nds;
      });
    },
    [setNodes]
  );

  // Load persisted layout once on boot.
  useEffect(() => {
    let isCancelled = false;

    const initializeLayout = async () => {
      try {
        const persistedLayout = await loadLayout(DEFAULT_VIEW_ID);
        if (isCancelled) return;

        const loadedNodes = Array.isArray(persistedLayout.nodes) ? persistedLayout.nodes : [];
        const loadedEdges = Array.isArray(persistedLayout.edges) ? persistedLayout.edges : [];

        setNodes(loadedNodes);
        setEdges(loadedEdges);

        const initialSnapshot = serializeLayoutSnapshot(loadedNodes, loadedEdges);
        lastPersistedSnapshotRef.current = initialSnapshot;
        currentHistorySnapshotRef.current = initialSnapshot;
        undoStackRef.current = [];
        pendingHistoryBaseRef.current = null;
        pendingHistoryNextRef.current = null;
      } catch (error) {
        console.error('Failed to load persisted DCIM layout:', error);
      } finally {
        if (!isCancelled) {
          setIsLayoutReady(true);
        }
      }
    };

    initializeLayout();

    return () => {
      isCancelled = true;
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (historyCommitTimeoutRef.current !== null) {
        window.clearTimeout(historyCommitTimeoutRef.current);
        historyCommitTimeoutRef.current = null;
      }
    };
  }, [setEdges, setNodes]);

  useEffect(() => {
    if (!isLayoutReady) return;
    let isCancelled = false;
    let intervalId: number | null = null;

    const syncSlurmStatuses = async () => {
      try {
        const slurmPayload = await loadSlurmStatuses();
        if (isCancelled) return;

        if (slurmPayload.enabled === false) {
          applySlurmRuntimeStatuses([]);
          return;
        }

        applySlurmRuntimeStatuses(slurmPayload.statuses);
      } catch (error) {
        console.error('Failed to sync Slurm statuses:', error);
      }
    };

    syncSlurmStatuses();
    intervalId = window.setInterval(syncSlurmStatuses, SLURM_SYNC_INTERVAL_MS);

    return () => {
      isCancelled = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [applySlurmRuntimeStatuses, isLayoutReady]);

  // Keep layout in persistent storage whenever nodes/edges change.
  useEffect(() => {
    if (!isLayoutReady) return;

    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(() => {
      const layoutToPersist = {
        nodes: sanitizeNodesForPersistence(nodes),
        edges: sanitizeEdgesForPersistence(edges),
      };
      const serializedLayout = JSON.stringify(layoutToPersist);

      if (serializedLayout === lastPersistedSnapshotRef.current) return;

      saveLayout(layoutToPersist, DEFAULT_VIEW_ID)
        .then(() => {
          lastPersistedSnapshotRef.current = serializedLayout;
        })
        .catch((error) => {
          console.error('Failed to persist DCIM layout:', error);
        });
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [nodes, edges, isLayoutReady]);

  // Track undo history based on sanitized snapshots so transient highlight state is ignored.
  useEffect(() => {
    if (!isLayoutReady) return;

    const serializedSnapshot = serializeLayoutSnapshot(nodes, edges);

    if (!currentHistorySnapshotRef.current) {
      currentHistorySnapshotRef.current = serializedSnapshot;
      return;
    }

    if (serializedSnapshot === currentHistorySnapshotRef.current) {
      return;
    }

    if (isApplyingHistoryRef.current) {
      isApplyingHistoryRef.current = false;
      currentHistorySnapshotRef.current = serializedSnapshot;
      pendingHistoryBaseRef.current = null;
      pendingHistoryNextRef.current = null;
      return;
    }

    if (pendingHistoryBaseRef.current === null) {
      pendingHistoryBaseRef.current = currentHistorySnapshotRef.current;
    }
    pendingHistoryNextRef.current = serializedSnapshot;
    currentHistorySnapshotRef.current = serializedSnapshot;

    if (historyCommitTimeoutRef.current !== null) {
      window.clearTimeout(historyCommitTimeoutRef.current);
    }

    historyCommitTimeoutRef.current = window.setTimeout(() => {
      flushPendingHistoryEntry();
    }, HISTORY_GROUP_DELAY_MS);
  }, [nodes, edges, isLayoutReady, flushPendingHistoryEntry]);

  // Theme Toggle Effect
  useEffect(() => {
    if (isDark) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  // Auto-hide help after 10s
  useEffect(() => {
     const timer = setTimeout(() => setShowHelp(false), 10000);
     return () => clearTimeout(timer);
  }, []);

  // Handle Spacebar listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        const isTyping = isTextEditingTarget(e.target);
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
            if (isTyping) return;
            e.preventDefault();
            handleUndo();
            return;
        }
        if (isTyping) return;
        if (e.code === 'Space' && !e.repeat) setIsSpacePressed(true);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
        if (e.code === 'Space') setIsSpacePressed(false);
    };
    
    const handleBlur = () => setIsSpacePressed(false);

    // Capture phase avoids missing shortcuts when inner components stop propagation.
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
        window.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('keyup', handleKeyUp);
        window.removeEventListener('blur', handleBlur);
    };
  }, [handleUndo]);

  // Highlight Type logic
  useEffect(() => {
    let type: ItemType | null = null;
    if (selectedNode) {
         if (selectedNode.type === 'placeholder') type = ItemType.PLACEHOLDER;
         else if (selectedNode.type === 'rack') type = ItemType.RACK;
         else if (selectedNode.type === 'zone') type = ItemType.ZONE;
         else type = (selectedNode.data as ServerData).type;
    }
    setActiveType(type);
    setIsHighlightActive(false); 
  }, [selectedNode]);

  // Apply visual highlights for Search/Filter
  useEffect(() => {
     setNodes(nds => nds.map(node => {
        let myType = node.type; 
        const isMatched = isHighlightActive && activeType && myType === activeType;
        if (node.data.isMatchedType !== isMatched) {
            return { ...node, data: { ...node.data, isMatchedType: isMatched } };
        }
        return node;
     }));
  }, [activeType, isHighlightActive, setNodes]);

  // Apply visual highlights for Drag Target (Drop Zone)
  useEffect(() => {
     setNodes(nds => nds.map(node => {
         if (node.type !== ItemType.RACK && node.type !== ItemType.PLACEHOLDER) return node;
         const isTarget = node.id === targetRackId;
         if (node.data.isDropTarget !== isTarget) {
             return { ...node, data: { ...node.data, isDropTarget: isTarget } };
         }
         return node;
     }));
  }, [targetRackId, setNodes]);

  // Search functionality
  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchMatches([]);
      setCurrentMatchIndex(-1);
      // Clear all highlights
      setNodes(nds => nds.map(node => ({
        ...node,
        data: { ...node.data, isSearchMatch: false, isCurrentSearchMatch: false }
      })));
      return;
    }

    const matches = nodes.filter(node => {
      const data = node.data as ServerData;
      const labelMatch = data.label?.toLowerCase().includes(query.toLowerCase());
      const ipMatch = data.ip?.toLowerCase().includes(query.toLowerCase());
      return labelMatch || ipMatch;
    });

    setSearchMatches(matches);
    setCurrentMatchIndex(matches.length > 0 ? 0 : -1);

    // Update node highlights
    setNodes(nds => nds.map(node => {
      const isMatch = matches.some(m => m.id === node.id);
      const isCurrent = matches.length > 0 && matches[0].id === node.id;
      return {
        ...node,
        data: { ...node.data, isSearchMatch: isMatch, isCurrentSearchMatch: isCurrent }
      };
    }));

    // Center on first match
    if (matches.length > 0 && reactFlowInstance) {
      const firstMatch = matches[0];
      const nodePos = getAbsolutePosition(firstMatch, nodes);
      reactFlowInstance.setCenter(nodePos.x + (firstMatch.width || 200) / 2, nodePos.y + (firstMatch.height || 50) / 2, { zoom: 1 });
    }
  }, [nodes, setNodes, reactFlowInstance]);

  const handlePrevMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    const newIndex = currentMatchIndex <= 0 ? searchMatches.length - 1 : currentMatchIndex - 1;
    setCurrentMatchIndex(newIndex);
    const match = searchMatches[newIndex];
    if (match && reactFlowInstance) {
      const nodePos = getAbsolutePosition(match, nodes);
      reactFlowInstance.setCenter(nodePos.x + (match.width || 200) / 2, nodePos.y + (match.height || 50) / 2, { zoom: 1 });
      // 只高亮节点，不打开编辑框
      setNodes(nds => nds.map(node => ({
        ...node,
        data: { ...node.data, isCurrentSearchMatch: node.id === match.id }
      })));
    }
  }, [searchMatches, currentMatchIndex, reactFlowInstance, nodes, setNodes]);

  const handleNextMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    const newIndex = currentMatchIndex >= searchMatches.length - 1 ? 0 : currentMatchIndex + 1;
    setCurrentMatchIndex(newIndex);
    const match = searchMatches[newIndex];
    if (match && reactFlowInstance) {
      const nodePos = getAbsolutePosition(match, nodes);
      reactFlowInstance.setCenter(nodePos.x + (match.width || 200) / 2, nodePos.y + (match.height || 50) / 2, { zoom: 1 });
      // 只高亮节点，不打开编辑框
      setNodes(nds => nds.map(node => ({
        ...node,
        data: { ...node.data, isCurrentSearchMatch: node.id === match.id }
      })));
    }
  }, [searchMatches, currentMatchIndex, reactFlowInstance, nodes, setNodes]);

  const onConnect = useCallback(
    (params: Connection) => {
        const newEdge = { 
            ...params, 
            type: 'portConnection',
            markerEnd: {
                type: MarkerType.ArrowClosed,
                color: isDark ? '#94a3b8' : '#475569',
            },
            zIndex: 900, // Below devices (1000) but visible
            data: {
                sourcePort: 'Port?',
                targetPort: 'Port?',
                speed: ''
            }
        };
        setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges, isDark]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    setSelectedNode(node);
    setSelectedEdge(null);
    setIsEditingNode(false);
    setMenu(null);
  }, []);

  const onEdgeClick = useCallback((event: React.MouseEvent, edge: Edge) => {
      event.preventDefault();
      event.stopPropagation();
      setSelectedEdge(edge);
      setSelectedNode((prevNode) => {
        if (prevNode && (prevNode.id === edge.source || prevNode.id === edge.target)) {
          return prevNode;
        }
        const sourceNode = nodes.find((n) => n.id === edge.source) || null;
        const targetNode = nodes.find((n) => n.id === edge.target) || null;
        return sourceNode || targetNode || prevNode || null;
      });
      setIsEditingNode(false);
      setMenu(null);
  }, [nodes]);

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      if (reactFlowWrapper.current) {
        const bounds = reactFlowWrapper.current.getBoundingClientRect();
        setMenu({
          id: node.id,
          top: event.clientY - bounds.top,
          left: event.clientX - bounds.left,
        });
        setSelectedNode(node);
        setSelectedEdge(null);
      }
    },
    []
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    setMenu(null);
    setIsEditingNode(false);
  }, []);

  const handleEdit = useCallback(() => {
    if (menu) {
        setIsEditingNode(true);
        const node = nodes.find(n => n.id === menu.id);
        if (node) setSelectedNode(node);
        setMenu(null);
    }
  }, [menu, nodes]);

  const handleDelete = useCallback(() => {
     if (menu) {
         setNodes((nds) => nds.filter((n) => n.id !== menu.id && n.parentId !== menu.id));
         setMenu(null);
         setSelectedNode(null);
     }
  }, [menu, setNodes]);

  const handleDuplicate = useCallback(() => {
      if (menu) {
          const nodeToCopy = nodes.find(n => n.id === menu.id);
          if (nodeToCopy) {
              const newId = getId();
              const position = {
                  x: nodeToCopy.position.x + 20,
                  y: nodeToCopy.position.y + 20
              };
              const newNode = {
                  ...nodeToCopy,
                  id: newId,
                  position,
                  selected: false,
                  zIndex: nodeToCopy.zIndex, // Preserve zIndex
                  data: {
                      ...nodeToCopy.data,
                      label: `${nodeToCopy.data.label} (Copy)`
                  }
              };
              setNodes((nds) => nds.concat(newNode));
          }
          setMenu(null);
      }
  }, [menu, nodes, setNodes]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      if (!reactFlowWrapper.current || !reactFlowInstance) return;

      const dragDataString = event.dataTransfer.getData('application/reactflow');
      if (!dragDataString) return;

      const dragData: DragItem = JSON.parse(dragDataString);

      const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
      const position = project({
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      });

      let xOffset = 0;
      let yOffset = 0;
      let width = 0;
      let height = 0;
      let zIndex = Z_INDEX_DEVICE;

      if (dragData.type === ItemType.ZONE) {
          width = dragData.width || 400;
          height = dragData.height || 300;
          xOffset = width / 2;
          yOffset = height / 2;
          zIndex = Z_INDEX_ZONE;
      } else if (dragData.type === ItemType.RACK || dragData.type === ItemType.PLACEHOLDER) {
          height = (dragData.totalU || 42) * PX_PER_U + (RACK_PADDING_PX * 2) + RACK_HEADER_HEIGHT_PX;
          width = RACK_WIDTH_PX;
          xOffset = width / 2;
          yOffset = height / 2;
          zIndex = Z_INDEX_RACK;
      } else if (dragData.type === ItemType.VIRTUAL_MACHINE) {
          // 虚拟机使用4U高度，窄宽度
          width = 140;
          height = 120; // 4U = 4 * 30px
          xOffset = width / 2;
          yOffset = height / 2;
          zIndex = Z_INDEX_DEVICE;
      } else if (dragData.type === ItemType.TOWER_SERVER) {
          const towerUHeight = dragData.uHeight || DEFAULT_TOWER_SERVER_U;
          width = TOWER_SERVER_WIDTH_PX;
          height = towerUHeight * PX_PER_U;
          xOffset = width / 2;
          yOffset = height / 2;
          zIndex = Z_INDEX_DEVICE;
      } else if (dragData.type === ItemType.SOFTWARE) {
          width = 200;
          height = 80;
          xOffset = width / 2;
          yOffset = height / 2;
          zIndex = Z_INDEX_DEVICE;
      } else if (dragData.type === ItemType.UDF) {
          width = UDF_WIDTH_PX;
          height = UDF_HEIGHT_PX;
          xOffset = width / 2;
          yOffset = height / 2;
          zIndex = Z_INDEX_DEVICE;
      } else {
          height = (dragData.uHeight || 1) * PX_PER_U;
          width = SERVER_WIDTH_PX;
          xOffset = width / 2;
          yOffset = height / 2;
          zIndex = Z_INDEX_DEVICE;
      }

      const newNode: Node = {
        id: getId(),
        type: dragData.type,
        position: {
            x: position.x - xOffset,
            y: position.y - yOffset
        },
        style: { width, height },
        zIndex: zIndex,
        data: {
            label: dragData.label,
            totalU: dragData.totalU,
            uHeight: dragData.uHeight ?? (dragData.type === ItemType.TOWER_SERVER ? DEFAULT_TOWER_SERVER_U : undefined),
            type: dragData.type,
            status: 'active',
            description: dragData.type === ItemType.ZONE ? '拖拽调整大小...' : undefined,
            cpu: dragData.cpu,
            memory: dragData.memory,
            techStack: dragData.techStack,
            version: dragData.version,
            port: dragData.port,
            fiberPorts: dragData.fiberPorts ?? DEFAULT_FIBER_PORTS,
            networkPorts: dragData.networkPorts ?? DEFAULT_NETWORK_PORTS
        },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance, project, setNodes]
  );

  // Capture initial state for Revert logic
  const onNodeDragStart: NodeDragHandler = useCallback((event, node) => {
     dragStartNodeRef.current = JSON.parse(JSON.stringify(node));
  }, []);

  // Handle Dragging Visuals (Highlight Target Rack & Calculate U Position)
  const onNodeDrag: NodeDragHandler = useCallback((event, node) => {
      if (node.type === ItemType.RACK || node.type === ItemType.PLACEHOLDER || node.type === ItemType.ZONE) {
          if (targetRackId) {
              setTargetRackId(null);
              setNodes((nds) => nds.map((n) => {
                  if (n.type === ItemType.RACK || n.type === ItemType.PLACEHOLDER) {
                      return {
                          ...n,
                          data: { ...n.data, previewUPosition: null, previewUHeight: undefined }
                      };
                  }
                  return n;
              }));
          }
          return;
      }

      const currentNodes = getNodes();
      const absPos = getAbsolutePosition(node, currentNodes);
      
      const isUdf = node.type === ItemType.UDF;
      const isTowerServer = node.type === ItemType.TOWER_SERVER;
      const nodeHeight = isUdf ? UDF_HEIGHT_PX : (node.height || (node.data?.uHeight || 1) * PX_PER_U);
      const nodeWidth = isUdf ? UDF_WIDTH_PX : (node.width || (isTowerServer ? TOWER_SERVER_WIDTH_PX : SERVER_WIDTH_PX));
      
      const nodeRect = {
          x: absPos.x,
          y: absPos.y,
          width: nodeWidth,
          height: nodeHeight
      };

      if (isUdf) {
          const hoveredRack = currentNodes.find(n => {
              if (n.type !== ItemType.RACK) return false;
              if (n.id === node.id) return false;

              const rackAbs = getAbsolutePosition(n, currentNodes);
              const rackW = RACK_WIDTH_PX;
              const rackTotalU = n.data.totalU || 42;
              const rackH = (rackTotalU * PX_PER_U) + (RACK_PADDING_PX * 2) + RACK_HEADER_HEIGHT_PX;
              
              const rackTopArea = {
                  x: rackAbs.x,
                  y: rackAbs.y - UDF_HEIGHT_PX,
                  width: rackW,
                  height: UDF_HEIGHT_PX + 20
              };

              return checkCollision(nodeRect, rackTopArea);
          });

          const newTargetId = hoveredRack ? hoveredRack.id : null;

          setNodes((nds) => nds.map((n) => {
              if (n.type === ItemType.RACK) {
                  const isTarget = n.id === newTargetId;
                  return {
                      ...n,
                      data: {
                          ...n.data,
                          isDropTarget: isTarget
                      }
                  };
              }
              return n;
          }));

          if (newTargetId !== targetRackId) {
              setTargetRackId(newTargetId);
          }
          return;
      }

      const hoveredRack = currentNodes.find(n => {
          if (n.type !== ItemType.RACK && n.type !== ItemType.PLACEHOLDER) return false;
          if (n.id === node.id) return false;

          const rackAbs = getAbsolutePosition(n, currentNodes);
          const rackW = RACK_WIDTH_PX;
          const rackTotalU = n.data.totalU || 42;
          const rackH = (rackTotalU * PX_PER_U) + (RACK_PADDING_PX * 2) + RACK_HEADER_HEIGHT_PX;

          return checkCollision(nodeRect, { x: rackAbs.x, y: rackAbs.y, width: rackW, height: rackH });
      });

      const newTargetId = hoveredRack ? hoveredRack.id : null;

      let previewUPosition: number | null = null;
      let previewUHeight = node.data?.uHeight || 1;

      if (hoveredRack) {
          const rackAbs = getAbsolutePosition(hoveredRack, currentNodes);
          const relY = absPos.y - rackAbs.y;
          const relativeYInRackArea = relY - RACK_PADDING_PX;

          const maxIndexFromTop = hoveredRack.data.totalU - previewUHeight;
          const snappedIndexFromTop = Math.round(relativeYInRackArea / PX_PER_U);
          const clampedIndexFromTop = Math.max(0, Math.min(maxIndexFromTop, snappedIndexFromTop));

          // RackNode expects previewUPosition counted from bottom (0 = bottom)
          previewUPosition = maxIndexFromTop - clampedIndexFromTop;
      }

      setNodes((nds) => nds.map((n) => {
          if (n.type === ItemType.RACK || n.type === ItemType.PLACEHOLDER) {
              const isTarget = n.id === newTargetId;
              return {
                  ...n,
                  data: {
                      ...n.data,
                      isDropTarget: isTarget,
                      previewUPosition: isTarget ? previewUPosition : null,
                      previewUHeight: isTarget ? previewUHeight : undefined
                  }
              };
          }
          return n;
      }));

      if (newTargetId !== targetRackId) {
          setTargetRackId(newTargetId);
      }
  }, [getNodes, targetRackId, setNodes]);

  // Enhanced Drag Stop Handler with Multi-Level Collision Logic
  const onNodeDragStop: NodeDragHandler = useCallback(
    (event, node) => {
        setTargetRackId(null);

        if (node.type === ItemType.ZONE) {
            return;
        }

        setNodes((nds) => {
            const clearedNodes = nds.map((n) => {
                if (n.type === ItemType.RACK || n.type === ItemType.PLACEHOLDER) {
                    return {
                        ...n,
                        data: { ...n.data, previewUPosition: null, previewUHeight: undefined, isDropTarget: false }
                    };
                }
                return n;
            });
            const currentNode = clearedNodes.find(n => n.id === node.id);
            if (!currentNode) return clearedNodes;

            // Guard: a simple click can still fire drag-stop in some browsers.
            // If position/parent didn't change, keep the node where it is.
            const startNode = dragStartNodeRef.current;
            if (startNode && startNode.id === currentNode.id) {
                const dx = Math.abs((startNode.position?.x ?? 0) - (currentNode.position?.x ?? 0));
                const dy = Math.abs((startNode.position?.y ?? 0) - (currentNode.position?.y ?? 0));
                if (dx < 1 && dy < 1 && startNode.parentId === currentNode.parentId) {
                    return clearedNodes;
                }
            }

            const absPos = getAbsolutePosition(currentNode, clearedNodes);
            const absX = absPos.x;
            const absY = absPos.y;

            const isUdf = node.type === ItemType.UDF;
            const isTowerServer = node.type === ItemType.TOWER_SERVER;
            const nodeWidth = isUdf ? UDF_WIDTH_PX : (node.width || (currentNode.width) || (isTowerServer ? TOWER_SERVER_WIDTH_PX : SERVER_WIDTH_PX));
            const nodeHeight = isUdf ? UDF_HEIGHT_PX : (node.height || (currentNode.height) || 30);
            const nodeAbsRect = { x: absX, y: absY, width: nodeWidth, height: nodeHeight };

            if (isUdf) {
                const rackNodes = clearedNodes.filter(n => n.type === ItemType.RACK && n.id !== node.id);
                const targetRack = rackNodes.find(rack => {
                    const rackAbs = getAbsolutePosition(rack, clearedNodes);
                    const rackW = RACK_WIDTH_PX;
                    const rackTotalU = rack.data.totalU || 42;
                    const rackH = (rackTotalU * PX_PER_U) + (RACK_PADDING_PX * 2) + RACK_HEADER_HEIGHT_PX;
                    
                    const rackTopArea = {
                        x: rackAbs.x,
                        y: rackAbs.y - UDF_HEIGHT_PX,
                        width: rackW,
                        height: UDF_HEIGHT_PX + 20
                    };
                    return checkCollision(nodeAbsRect, rackTopArea);
                });

                if (targetRack) {
                    const rackAbs = getAbsolutePosition(targetRack, clearedNodes);
                    const relX = 0;
                    const relY = -UDF_HEIGHT_PX;

                    const hasUdfOnTop = clearedNodes.some(n => {
                        if (n.parentId !== targetRack.id) return false;
                        if (n.id === node.id) return false;
                        return n.type === ItemType.UDF;
                    });

                    if (hasUdfOnTop) {
                        return clearedNodes.map(n => n.id === node.id && dragStartNodeRef.current ? dragStartNodeRef.current : n);
                    }

                    return clearedNodes.map(n => n.id === node.id ? {
                        ...n,
                        parentId: targetRack.id,
                        position: { x: relX, y: relY },
                        zIndex: Z_INDEX_DEVICE
                    } : n);
                }

                const zoneNodes = clearedNodes.filter(n => n.type === ItemType.ZONE && n.id !== node.id);
                const targetZone = zoneNodes.find(zone => {
                    const zoneAbs = getAbsolutePosition(zone, clearedNodes);
                    const zoneW = parseInt(zone.style?.width as string) || zone.width || 400;
                    const zoneH = parseInt(zone.style?.height as string) || zone.height || 300;
                    const zoneRect = { x: zoneAbs.x, y: zoneAbs.y, width: zoneW, height: zoneH };
                    return checkCollision(nodeAbsRect, zoneRect);
                });

                if (targetZone) {
                    const zoneAbs = getAbsolutePosition(targetZone, clearedNodes);
                    const relX = absX - zoneAbs.x;
                    const relY = absY - zoneAbs.y;

                    return clearedNodes.map(n => n.id === node.id ? {
                        ...n,
                        parentId: targetZone.id,
                        position: { x: relX, y: relY },
                        zIndex: Z_INDEX_DEVICE
                    } : n);
                }

                return clearedNodes.map(n => n.id === node.id ? {
                    ...n,
                    parentId: undefined,
                    position: { x: absX, y: absY },
                    zIndex: Z_INDEX_DEVICE
                } : n);
            }

            const isDevice = node.type !== ItemType.RACK && node.type !== ItemType.PLACEHOLDER;

            if (isDevice) {
                 const rackNodes = clearedNodes.filter(n => n.type === ItemType.RACK && n.id !== node.id);
                 const targetRack = rackNodes.find(rack => {
                     const rackAbs = getAbsolutePosition(rack, clearedNodes);
                     const rackW = RACK_WIDTH_PX;
                     const rackTotalU = rack.data.totalU || 42;
                     const rackH = (rackTotalU * PX_PER_U) + (RACK_PADDING_PX * 2) + RACK_HEADER_HEIGHT_PX;
                     const rackRect = { x: rackAbs.x, y: rackAbs.y, width: rackW, height: rackH };
                     return checkCollision(nodeAbsRect, rackRect);
                 });

                 if (targetRack) {
                     const rackAbs = getAbsolutePosition(targetRack, clearedNodes);
                     const relY = absY - rackAbs.y;
                     const deviceUHeight = currentNode.data.uHeight || 1;
                     const maxIndexFromTop = targetRack.data.totalU - deviceUHeight;
                     const relativeYInRackArea = relY - RACK_PADDING_PX;
                     const snappedIndexFromTop = Math.round(relativeYInRackArea / PX_PER_U);
                     const clampedIndexFromTop = Math.max(0, Math.min(maxIndexFromTop, snappedIndexFromTop));
                     const finalY = (clampedIndexFromTop * PX_PER_U) + RACK_PADDING_PX;
                     let targetTowerColumn: number | null = null;
                     let finalX = RACK_PADDING_PX;
                     if (isTowerServer) {
                         targetTowerColumn = getTowerColumnForRackDrop(absX, rackAbs.x);
                         finalX = getTowerColumnX(targetTowerColumn);
                     }

                     const slotStart = clampedIndexFromTop;
                     const slotEnd = slotStart + deviceUHeight - 1;

                     const hasSlotCollision = clearedNodes.some(n => {
                         if (n.parentId !== targetRack.id) return false;
                         if (n.id === node.id) return false;

                         const nUHeight = n.data.uHeight || 1;
                         const nStartU = Math.round((n.position.y - RACK_PADDING_PX) / PX_PER_U);
                         const nEndU = nStartU + nUHeight - 1;
                         const hasVerticalOverlap = slotStart <= nEndU && slotEnd >= nStartU;
                         if (!hasVerticalOverlap) return false;

                         if (!isTowerServer) return true;
                         if (n.type !== ItemType.TOWER_SERVER) return true;

                         const occupiedColumn = getTowerColumnFromRackChild(n);
                         return occupiedColumn === targetTowerColumn;
                     });

                     if (hasSlotCollision) {
                         return clearedNodes.map(n => n.id === node.id && dragStartNodeRef.current ? dragStartNodeRef.current : n);
                     }

                     return clearedNodes.map(n => n.id === node.id ? {
                         ...n,
                         parentId: targetRack.id,
                         position: { x: finalX, y: finalY },
                         style: isTowerServer ? { ...n.style, width: TOWER_SERVER_WIDTH_PX } : n.style,
                         zIndex: Z_INDEX_DEVICE
                     } : n);
                 }
            }

            const zoneNodes = clearedNodes.filter(n => n.type === ItemType.ZONE && n.id !== node.id);
            const targetZone = zoneNodes.find(zone => {
                 const zoneAbs = getAbsolutePosition(zone, clearedNodes);
                 const zoneW = parseInt(zone.style?.width as string) || zone.width || 400;
                 const zoneH = parseInt(zone.style?.height as string) || zone.height || 300;
                 const zoneRect = { x: zoneAbs.x, y: zoneAbs.y, width: zoneW, height: zoneH };
                 return checkCollision(nodeAbsRect, zoneRect);
            });

            if (targetZone) {
                // Attach to Zone
                const zoneAbs = getAbsolutePosition(targetZone, clearedNodes);
                const relX = absX - zoneAbs.x;
                const relY = absY - zoneAbs.y;

                return clearedNodes.map(n => n.id === node.id ? {
                    ...n,
                    parentId: targetZone.id,
                    position: { x: relX, y: relY },
                    zIndex: isDevice ? Z_INDEX_DEVICE : Z_INDEX_RACK
                } : n);
            }

            // -- NO PARENT (Canvas) --
            // If we are here, we are not in a Rack, and not in a Zone.
            // Or we were in a rack/zone and dragged out to empty space.
            
            // Check for collision with other items in canvas (only for devices vs devices to avoid overlap)
            if (isDevice) {
                const hasOverlap = clearedNodes.some(n => {
                    if (n.id === node.id) return false;
                    if (n.type === ItemType.RACK || n.type === ItemType.PLACEHOLDER || n.type === ItemType.ZONE) return false;

                    const nAbs = getAbsolutePosition(n, clearedNodes);
                    const nRect = {
                        x: nAbs.x,
                        y: nAbs.y,
                        width: n.width || (n.type === ItemType.TOWER_SERVER ? TOWER_SERVER_WIDTH_PX : SERVER_WIDTH_PX),
                        height: n.height || 30
                    };
                    return checkCollision(nodeAbsRect, nRect);
                });

                if (hasOverlap) {
                    return clearedNodes.map(n => n.id === node.id && dragStartNodeRef.current ? dragStartNodeRef.current : n);
                }
            }

            // Detach completely
            return clearedNodes.map(n => n.id === node.id ? {
                ...n,
                parentId: undefined,
                position: { x: absX, y: absY },
                zIndex: isDevice ? Z_INDEX_DEVICE : Z_INDEX_RACK
            } : n);

        });
    },
    [setNodes]
  );

  // 鼠标悬停事件处理 - 显示机柜内节点的U位位置
  const onNodeMouseEnter = useCallback((event: React.MouseEvent, node: Node) => {
    // 只处理机柜内的设备节点
    if (!node.parentId) return;
    
    const currentNodes = getNodes();
    const parentNode = currentNodes.find(n => n.id === node.parentId);
    
    // 只处理机柜父节点
    if (!parentNode || (parentNode.type !== ItemType.RACK && parentNode.type !== ItemType.PLACEHOLDER)) return;
    
    // 计算节点的U位位置（从底部开始）
    const nodeUHeight = node.data?.uHeight || 1;
    const rackTotalU = parentNode.data.totalU || 42;
    
    // 将存储的Y坐标转换回从底部开始的U位置
    const nIndexFromTop = Math.round((node.position.y - RACK_PADDING_PX) / PX_PER_U);
    const uPositionFromBottom = (rackTotalU - nodeUHeight) - nIndexFromTop;
    
    // 更新机柜的预览数据
    setNodes((nds) => nds.map((n) => {
      if (n.id === parentNode.id) {
        return {
          ...n,
          data: {
            ...n.data,
            previewUPosition: uPositionFromBottom,
            previewUHeight: nodeUHeight
          }
        };
      }
      return n;
    }));
  }, [getNodes, setNodes]);

  // 鼠标离开事件处理 - 清除U位位置显示
  const onNodeMouseLeave = useCallback(() => {
    // 清除所有机柜的预览位置
    setNodes((nds) => nds.map((n) => {
      if (n.type === ItemType.RACK || n.type === ItemType.PLACEHOLDER) {
        return {
          ...n,
          data: {
            ...n.data,
            previewUPosition: null,
            previewUHeight: undefined
          }
        };
      }
      return n;
    }));
  }, [setNodes]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 dark:bg-[#0f172a] text-slate-900 dark:text-white transition-colors duration-300">
      <Sidebar 
        onSearch={handleSearch}
        searchQuery={searchQuery}
        onPrevMatch={handlePrevMatch}
        onNextMatch={handleNextMatch}
        matchCount={searchMatches.length}
        currentMatchIndex={currentMatchIndex}
      />
      
      <div className="flex-1 h-full relative" ref={reactFlowWrapper}>
        <ReactFlow
          nodes={nodes}
          edges={visibleEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setReactFlowInstance}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          onNodeContextMenu={onNodeContextMenu}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          panOnScroll={!isSpacePressed}
          panOnDrag={isSpacePressed || [1, 2]}
          selectionOnDrag={!isSpacePressed}
          fitView
          minZoom={0.05}
          maxZoom={2}
          className="bg-slate-50 dark:bg-[#0f172a]"
          proOptions={{ hideAttribution: true }}
          connectionRadius={40}
          connectionMode="loose"
          snapToGrid={false}
          snapGrid={[15, 15]}
        >
          <Background 
            variant={BackgroundVariant.Dots} 
            gap={20} 
            size={1} 
            color={isDark ? "#334155" : "#cbd5e1"} 
          />
          <Controls>
            <ControlButton
              onClick={handleUndo}
              title="撤销 (Ctrl+Z)"
              aria-label="撤销 (Ctrl+Z)"
              className="rf-undo-control"
            >
              <i className="fa-solid fa-rotate-left text-[12px] leading-none"></i>
            </ControlButton>
          </Controls>
          <MiniMap 
            nodeColor={nodeColor} 
            style={{ backgroundColor: isDark ? '#1e293b' : '#f8fafc' }} 
            maskColor={isDark ? "rgba(15, 23, 42, 0.6)" : "rgba(255, 255, 255, 0.6)"} 
          />
          
          <VisibilityControls />
          <GeminiAdvisor 
              isDark={isDark} 
              onThemeChange={setIsDark} 
              onImportComplete={handleImportComplete}
              externalSetNodes={setNodes}
              externalSetEdges={setEdges}
          />

          {/* Type Highlighter Panel */}
          {activeType && selectedNode && (
            <Panel position="top-center" className="mt-4">
                 <div className="bg-white/80 dark:bg-slate-800/80 backdrop-blur border border-slate-200 dark:border-slate-600 rounded-full px-4 py-2 flex items-center gap-3 shadow-xl">
                    <span className="text-xs text-slate-600 dark:text-slate-300 font-medium">
                        Highlighting: <span className="text-slate-900 dark:text-white font-bold">{activeType.toUpperCase()}</span>
                    </span>
                    <button 
                        onClick={() => setIsHighlightActive(!isHighlightActive)}
                        className={`w-10 h-5 rounded-full relative transition-colors duration-200 ${isHighlightActive ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-600'}`}
                    >
                        <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all duration-200 ${isHighlightActive ? 'left-6' : 'left-1'}`}></div>
                    </button>
                 </div>
            </Panel>
          )}

          {/* Instructions Overlay */}
          {showHelp && (
            <Panel position="bottom-center" className="mb-8 pointer-events-none">
                 <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur px-6 py-3 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-xs shadow-2xl flex items-center gap-4 animate-bounce">
                    <span className="flex items-center gap-2">
                        <i className="fa-solid fa-hand-pointer"></i> Select
                    </span>
                    <span className="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>
                    <span className="flex items-center gap-2">
                        <span className="bg-slate-200 dark:bg-slate-700 px-1.5 rounded text-[10px]">Space</span> + Drag to Pan
                    </span>
                    <span className="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>
                    <span className="flex items-center gap-2">
                        <i className="fa-solid fa-bezier-curve"></i> Connect Devices
                    </span>
                 </div>
            </Panel>
          )}

        </ReactFlow>

        {/* Details Panels */}
        {selectedNode && (
            <NodeDetailsPanel 
                node={selectedNode} 
                onClose={() => setSelectedNode(null)} 
                isEditing={isEditingNode}
            />
        )}
        
        {selectedEdge && (
            <EdgeDetailsPanel 
                edge={selectedEdge} 
                onClose={() => setSelectedEdge(null)} 
            />
        )}

        {/* Context Menu */}
        {menu && (
            <ContextMenu 
                top={menu.top} 
                left={menu.left} 
                onEdit={handleEdit}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                onClose={() => setMenu(null)}
            />
        )}
      </div>
    </div>
  );
};

export default function SmartDCIM() {
  return (
    <ReactFlowProvider>
      <DCIMCanvas />
    </ReactFlowProvider>
  );
}
