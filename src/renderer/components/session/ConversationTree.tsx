import type { Message, Session } from '@shared/types'
import { getMessageText } from '@shared/utils/message'
import type { Node } from '@xyflow/react'
import { Background, Controls, Handle, Position, ReactFlow, useEdgesState, useNodesState, useViewport } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getContextMessageIds } from '@/packages/context-management'
import { scrollToMessage } from '@/stores/scrollActions'
import { switchForkToPosition } from '@/stores/session/forks'
import { switchThread as switchThreadAction } from '@/stores/sessionActions'

type MessageFork = NonNullable<Session['messageForksHash']>[string]

// ─── Layout constants ─────────────────────────────────────────────────────────

const NODE_W = 180
const NODE_H = 80
const STEP_Y = NODE_H + 60
const STEP_X = NODE_W + 12
const SLIM_STEP_X = NODE_W + 10 

// ─── Node component ───────────────────────────────────────────────────────────

type ForkStep = { forkMsgId: string; listIndex: number }

interface MessageNodeData {
  role: string
  text: string
  isActive: boolean
  isInContext: boolean
  messageId: string
  threadId: string
  isCurrentThread: boolean
  forkChain: ForkStep[] // steps needed to switch to reach this node
  onClick: () => void
  [key: string]: unknown
}

const ROLE_LABEL: Record<string, string> = { system: 'S', user: 'U', assistant: 'A' }
const ROLE_COLOR: Record<string, string> = {
  system: 'bg-orange-100 text-orange-700',
  user: 'bg-blue-100 text-blue-700',
  assistant: 'bg-green-100 text-green-700',
}

function MessageNode({ data }: { data: MessageNodeData }) {
  const { zoom } = useViewport()
  const roleLabel = ROLE_LABEL[data.role] ?? data.role[0]?.toUpperCase() ?? '?'
  const roleColor = ROLE_COLOR[data.role] ?? 'bg-gray-100 text-gray-700'
  // Scale ring so it stays at least 3px on screen regardless of zoom level
  const ringPx = data.isInContext ? Math.max(3, Math.round(3 / zoom)) : 0
  return (
    <div
      style={ringPx ? { boxShadow: `0 0 0 ${ringPx}px #fb923c` } : undefined}
      className={[
        'rounded-xl border px-3 py-2 cursor-pointer w-[180px] transition-all select-none',
        data.isActive
          ? 'bg-white border-blue-400 shadow-sm shadow-blue-100'
          : 'bg-white border-gray-200 opacity-60',
      ].join(' ')}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0 !w-0 !h-0" />
      <div className="flex items-start gap-2">
        <span className={`text-[10px] font-bold rounded px-1 py-0.5 shrink-0 mt-0.5 ${roleColor}`}>
          {roleLabel}
        </span>
        <p className="text-xs leading-snug text-gray-700 line-clamp-3 break-words min-w-0">
          {data.text || '…'}
        </p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0 !w-0 !h-0" />
    </div>
  )
}

interface DividerNodeData { width: number; [key: string]: unknown }

function ContextDividerNode({ data }: { data: DividerNodeData }) {
  return (
    <div style={{ width: data.width, pointerEvents: 'none', position: 'relative', height: 2 }}>
      <div style={{ position: 'absolute', inset: 0, background: '#fb923c', opacity: 0.55 }} />
      <span style={{
        position: 'absolute', right: 0, top: -14,
        fontSize: 9, color: '#fb923c', background: 'white',
        padding: '1px 4px', borderRadius: 3, whiteSpace: 'nowrap',
      }}>
        context window ↓
      </span>
    </div>
  )
}

const nodeTypes = { message: MessageNode, 'context-divider': ContextDividerNode }

// ─── Abstract tree ────────────────────────────────────────────────────────────

interface TNode {
  id: string
  msg: Message
  isActive: boolean
  depth: number
  children: TNode[]
  width: number // subtree leaf-column count (computed bottom-up)
  x: number // final x position (computed top-down)
  branchLength: number // longest path depth in this subtree
  hasForks: boolean // whether this subtree contains fork points
  forkChain: ForkStep[] // accumulated fork switches to reach this node
}

/**
 * Build an abstract tree from a flat message array + fork metadata.
 *
 * Each message becomes a tree node. Without a fork the next message in
 * the array is the single child. At a fork the children are the first
 * messages of every branch (active continuation + inactive lists), in
 * their natural list-index order.
 */
function buildTree(
  msgs: Message[],
  forks: Record<string, MessageFork> | undefined,
  idPrefix: string,
  isActive: boolean,
  depth: number,
  branchDepth: number | null,
  nestDepth: number,
  idx: number,
  forkChain: ForkStep[] = []
): TNode | null {
  if (idx >= msgs.length) return null

  const msg = msgs[idx]
  const node: TNode = {
    id: `${idPrefix}${msg.id}`,
    msg,
    isActive,
    depth,
    children: [],
    width: 1,
    x: 0,
    branchLength: 0,
    hasForks: false,
    forkChain,
  }

  const fork = forks?.[msg.id]
  const expand = fork && branchDepth !== 0 && (branchDepth === null || nestDepth < branchDepth)

  if (expand) {
    for (let li = 0; li < fork.lists.length; li++) {
      if (li === fork.position) {
        // Active continuation — fork chain unchanged
        if (idx + 1 < msgs.length) {
          const child = buildTree(msgs, forks, idPrefix, isActive, depth + 1, branchDepth, nestDepth, idx + 1, forkChain)
          if (child) node.children.push(child)
        }
      } else {
        // Inactive branch — append this fork step to the chain
        const list = fork.lists[li]
        if (list.messages.length > 0) {
          const childChain: ForkStep[] = [...forkChain, { forkMsgId: msg.id, listIndex: li }]
          const child = buildTree(list.messages, forks, idPrefix, false, depth + 1, branchDepth, nestDepth + 1, 0, childChain)
          if (child) node.children.push(child)
        }
      }
    }
  } else if (idx + 1 < msgs.length) {
    const child = buildTree(msgs, forks, idPrefix, isActive, depth + 1, branchDepth, nestDepth, idx + 1, forkChain)
    if (child) node.children.push(child)
  }

  return node
}

// ─── Annotate: compute branchLength and hasForks per subtree ──────────────────

function annotate(node: TNode): void {
  if (node.children.length === 0) {
    node.branchLength = 1
    node.hasForks = false
    return
  }
  node.hasForks = node.children.length > 1
  let maxLen = 0
  for (const child of node.children) {
    annotate(child)
    if (child.hasForks) node.hasForks = true
    if (child.branchLength > maxLen) maxLen = child.branchLength
  }
  node.branchLength = 1 + maxLen
}

// ─── Modified Reingold-Tilford layout ─────────────────────────────────────────
//
// Pass 1 (bottom-up)  — computeWidths: every leaf occupies 1 column;
//                        every internal node occupies the sum of its children.
//
// Pass 2 (top-down)   — assignX: children are distributed left-to-right
//                        within the parent's allocated horizontal band, then
//                        the parent is centered over its first and last child.
//
// This guarantees zero overlap and produces compact, balanced trees.

function classifyChildren(children: TNode[]): { slim: Set<TNode> } {
  const forkLens = children.filter((c) => c.hasForks).map((c) => c.branchLength)
  const anyFork = forkLens.length > 0
  const minForkLen = anyFork ? Math.min(...forkLens) : Infinity
  // Active branch is never slim
  const slim = new Set(children.filter((c) =>
    anyFork && !c.hasForks && !c.isActive && c.branchLength <= minForkLen
  ))
  return { slim }
}

function childPx(child: TNode, slim: Set<TNode>): number {
  return slim.has(child) ? SLIM_STEP_X : child.width * STEP_X
}

function computeWidths(node: TNode): void {
  if (node.children.length === 0) { node.width = 1; return }
  for (const child of node.children) computeWidths(child)
  const { slim } = classifyChildren(node.children)
  const totalPx = node.children.reduce((s, c) => s + childPx(c, slim), 0)
  node.width = Math.max(1, Math.ceil(totalPx / STEP_X))
}

function assignX(node: TNode, left: number): void {
  if (node.children.length === 0) { node.x = left; return }

  const { slim } = classifyChildren(node.children)
  const activeChild = node.children.find((c) => c.isActive) ?? null

  if (!activeChild || node.children.length === 1) {
    // No fork or single child — plain left-to-right
    let cursor = left
    for (const child of node.children) {
      assignX(child, cursor)
      cursor += childPx(child, slim)
    }
    const xs = node.children.map((c) => c.x)
    node.x = (Math.min(...xs) + Math.max(...xs)) / 2
    return
  }

  // Children before active go left, children after go right (natural order preserved)
  const activeIdx = node.children.indexOf(activeChild)
  const leftGroup = node.children.slice(0, activeIdx)
  const rightGroup = node.children.slice(activeIdx + 1)

  // Left group width determines where the active child lands
  const leftPx = leftGroup.reduce((s, c) => s + childPx(c, slim), 0)
  const activeLeft = left + leftPx
  assignX(activeChild, activeLeft)

  // Place left group right-to-left from the active child
  let cursor = activeLeft
  for (let i = leftGroup.length - 1; i >= 0; i--) {
    cursor -= childPx(leftGroup[i], slim)
    assignX(leftGroup[i], cursor)
  }

  // Place right group left-to-right after the active child
  cursor = activeLeft + childPx(activeChild, slim)
  for (const child of rightGroup) {
    assignX(child, cursor)
    cursor += childPx(child, slim)
  }

  const xs = node.children.map((c) => c.x)
  node.x = (Math.min(...xs) + Math.max(...xs)) / 2
}

// ─── Flatten tree → ReactFlow nodes + edges ───────────────────────────────────

interface LayoutNode {
  id: string
  x: number
  y: number
  data: MessageNodeData
}
interface LayoutEdge {
  id: string
  source: string
  target: string
  isActive: boolean
}

function flatten(
  node: TNode,
  threadId: string,
  isCurrentThread: boolean,
  contextIds: Set<string>,
  onClick: (msgId: string, threadId: string, isCurrent: boolean, forkChain: ForkStep[]) => void,
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): void {
  nodes.push({
    id: node.id,
    x: node.x,
    y: node.depth * STEP_Y,
    data: {
      role: node.msg.role,
      text: getMessageText(node.msg),
      isActive: node.isActive,
      isInContext: contextIds.has(node.msg.id),
      messageId: node.msg.id,
      threadId,
      isCurrentThread,
      forkChain: node.forkChain,
      onClick: () => onClick(node.msg.id, threadId, isCurrentThread, node.forkChain),
    },
  })
  for (const child of node.children) {
    edges.push({
      id: `e-${node.id}-${child.id}`,
      source: node.id,
      target: child.id,
      isActive: node.isActive && child.isActive,
    })
    flatten(child, threadId, isCurrentThread, contextIds, onClick, nodes, edges)
  }
}

function layoutThread(
  messages: Message[],
  forksHash: Record<string, MessageFork> | undefined,
  branchDepth: number | null,
  idPrefix: string,
  threadId: string,
  isCurrentThread: boolean,
  contextIds: Set<string>,
  onClick: (msgId: string, threadId: string, isCurrent: boolean, forkChain: ForkStep[]) => void
): { nodes: LayoutNode[]; edges: LayoutEdge[]; dividerY: number | null; minX: number; maxX: number } {
  const root = buildTree(messages, forksHash, idPrefix, true, 0, branchDepth, 0, 0)
  if (!root) return { nodes: [], edges: [], dividerY: null, minX: 0, maxX: NODE_W }
  annotate(root)
  computeWidths(root)
  assignX(root, 0)
  const nodes: LayoutNode[] = []
  const edges: LayoutEdge[] = []
  flatten(root, threadId, isCurrentThread, contextIds, onClick, nodes, edges)

  // Shift so the active branch starts at x = 0 (leftmost position)
  const activeXs = nodes.filter((n) => n.data.isActive).map((n) => n.x)
  if (activeXs.length > 0) {
    const activeLeft = Math.min(...activeXs)
    for (const n of nodes) n.x -= activeLeft
  }

  // Compute divider y: midpoint between last non-context and first context active node
  const activeNodes = nodes.filter((n) => n.data.isActive).sort((a, b) => a.y - b.y)
  let dividerY: number | null = null
  for (let i = 1; i < activeNodes.length; i++) {
    if (!activeNodes[i - 1].data.isInContext && activeNodes[i].data.isInContext) {
      dividerY = (activeNodes[i - 1].y + NODE_H + activeNodes[i].y) / 2
      break
    }
  }

  const allX = nodes.map((n) => n.x)
  const minX = Math.min(...allX)
  const maxX = Math.max(...allX)

  return { nodes, edges, dividerY, minX, maxX }
}

// ─── Main component ───────────────────────────────────────────────────────────

const DEPTH_OPTIONS: { label: string; value: number | null }[] = [
  { label: '0', value: 0 },
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: '∞', value: null },
]

export default function ConversationTree({ session }: { session: Session }) {
  const [branchDepth, setBranchDepth] = useState<number | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const handleNodeClick = useCallback(
    async (msgId: string, threadId: string, isCurrentThread: boolean, forkChain: ForkStep[]) => {
      if (!isCurrentThread) {
        void switchThreadAction(session.id, threadId)
        return
      }
      // Switch forks along the chain to reach this branch
      for (const step of forkChain) {
        await switchForkToPosition(session.id, step.forkMsgId, step.listIndex)
      }
      // scrollToMessage fetches the fresh session so the index accounts for
      // archived thread messages prepended to the list
      void scrollToMessage(session.id, msgId, 'start', 'smooth')
    },
    [session.id]
  )

  const contextIds = useMemo(
    () => new Set(getContextMessageIds(session, session.settings?.maxContextMessageCount)),
    [session]
  )

  const { flowNodes, flowEdges } = useMemo(() => {
    const allNodes: Node[] = []
    const allEdges: {
      id: string
      source: string
      target: string
      type: string
      animated: boolean
      pathOptions?: object
      style: object
    }[] = []

    let yOffset = 0

    const addThread = (
      msgs: Message[],
      forks: Record<string, MessageFork> | undefined,
      idPrefix: string,
      threadId: string,
      isCurrentThread: boolean,
      threadContextIds: Set<string>,
      label?: string
    ) => {
      if (msgs.length === 0) return

      if (label) {
        allNodes.push({
          id: `sep_${idPrefix}`,
          type: 'default',
          position: { x: 0, y: yOffset },
          data: { label },
          style: {
            background: 'transparent',
            border: 'none',
            fontSize: 11,
            color: '#9ca3af',
            padding: 0,
            width: 180,
          },
          selectable: false,
          draggable: false,
        })
        yOffset += 28
      }

      const { nodes, edges, dividerY, minX, maxX } = layoutThread(
        msgs, forks, branchDepth, idPrefix, threadId, isCurrentThread, threadContextIds, handleNodeClick
      )

      for (const n of nodes) {
        allNodes.push({
          id: n.id,
          type: 'message',
          position: { x: n.x, y: yOffset + n.y },
          data: n.data,
          selectable: false,
          draggable: false,
        })
      }

      // Context boundary divider line
      if (dividerY !== null) {
        const pad = 24
        const divW = maxX - minX + NODE_W + pad * 2
        allNodes.push({
          id: `divider_${idPrefix}`,
          type: 'context-divider',
          position: { x: minX - pad, y: yOffset + dividerY },
          data: { width: divW },
          selectable: false,
          draggable: false,
        })
      }

      for (const e of edges) {
        allEdges.push({
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'smoothstep',
          animated: e.isActive,
          pathOptions: { borderRadius: 4 },
          style: {
            stroke: e.isActive ? '#60a5fa' : '#d1d5db',
            strokeWidth: e.isActive ? 2 : 1.5,
            vectorEffect: 'non-scaling-stroke',
          },
        })
      }

      const maxY = nodes.reduce((m, n) => Math.max(m, n.y), 0)
      yOffset += maxY + NODE_H + 60
    }

    addThread(session.messages, session.messageForksHash, 'cur_', session.id, true, contextIds)

    if (showArchived && session.threads) {
      for (const thread of session.threads) {
        addThread(
          thread.messages,
          thread.messageForksHash,
          `th_${thread.id}_`,
          thread.id,
          false,
          new Set(), // no context highlighting for archived threads
          thread.name || 'Archived thread'
        )
      }
    }

    // Active edges last so they render on top of inactive ones
    allEdges.sort((a, b) => (a.animated ? 1 : 0) - (b.animated ? 1 : 0))

    return { flowNodes: allNodes, flowEdges: allEdges }
  }, [session, branchDepth, contextIds, showArchived, handleNodeClick])

  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges)

  useEffect(() => { setNodes(flowNodes) }, [flowNodes, setNodes])
  useEffect(() => { setEdges(flowEdges) }, [flowEdges, setEdges])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-gray-100 shrink-0 flex-wrap">
        <span className="text-xs text-gray-500">Branch reach:</span>
        <div className="flex rounded-md overflow-hidden border border-gray-200">
          {DEPTH_OPTIONS.map((opt) => (
            <button
              key={String(opt.value)}
              onClick={() => setBranchDepth(opt.value)}
              className={[
                'px-2 py-0.5 text-xs font-medium transition-colors',
                branchDepth === opt.value
                  ? 'bg-blue-500 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50',
              ].join(' ')}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {!!session.threads?.length && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className={[
              'px-2 py-0.5 text-xs font-medium rounded-md border transition-colors',
              showArchived
                ? 'bg-blue-500 text-white border-blue-500'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50',
            ].join(' ')}
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.001}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          onNodeClick={(_, node) => (node.data as MessageNodeData).onClick?.()}
          className="bg-gray-50 [&_.react-flow__node]:cursor-pointer"
        >
          <Controls showInteractive={false} />
          <Background color="#e5e7eb" gap={20} size={1} />
        </ReactFlow>
      </div>
    </div>
  )
}
