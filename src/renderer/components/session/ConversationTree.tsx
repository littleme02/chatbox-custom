import type { Message, Session } from '@shared/types'
import { getMessageText } from '@shared/utils/message'
import type { Node } from '@xyflow/react'
import { Background, Controls, Handle, Position, ReactFlow, useEdgesState, useNodesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { scrollToIndex } from '@/stores/scrollActions'
import { switchThread as switchThreadAction } from '@/stores/sessionActions'

type MessageFork = NonNullable<Session['messageForksHash']>[string]

// ─── Layout constants ─────────────────────────────────────────────────────────

const NODE_W = 180
const NODE_H = 80
const STEP_Y = NODE_H + 60
const STEP_X = NODE_W + 30

// ─── Node component ───────────────────────────────────────────────────────────

interface MessageNodeData {
  role: string
  text: string
  isActive: boolean
  messageId: string
  threadId: string
  isCurrentThread: boolean
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
  const roleLabel = ROLE_LABEL[data.role] ?? data.role[0]?.toUpperCase() ?? '?'
  const roleColor = ROLE_COLOR[data.role] ?? 'bg-gray-100 text-gray-700'
  return (
    <div
      onClick={data.onClick}
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

const nodeTypes = { message: MessageNode }

// ─── Abstract tree ────────────────────────────────────────────────────────────

interface TNode {
  id: string
  msg: Message
  isActive: boolean
  depth: number
  children: TNode[]
  width: number // subtree leaf-column count (computed bottom-up)
  x: number // final x position (computed top-down)
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
  idx: number
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
  }

  const fork = forks?.[msg.id]
  const expand = fork && branchDepth !== 0 && (branchDepth === null || nestDepth < branchDepth)

  if (expand) {
    for (let li = 0; li < fork.lists.length; li++) {
      if (li === fork.position) {
        // Active continuation — keep walking the same message array
        if (idx + 1 < msgs.length) {
          const child = buildTree(msgs, forks, idPrefix, isActive, depth + 1, branchDepth, nestDepth, idx + 1)
          if (child) node.children.push(child)
        }
      } else {
        // Inactive branch — walk that branch's stored messages
        const list = fork.lists[li]
        if (list.messages.length > 0) {
          const child = buildTree(list.messages, forks, idPrefix, false, depth + 1, branchDepth, nestDepth + 1, 0)
          if (child) node.children.push(child)
        }
      }
    }

  } else if (idx + 1 < msgs.length) {
    const child = buildTree(msgs, forks, idPrefix, isActive, depth + 1, branchDepth, nestDepth, idx + 1)
    if (child) node.children.push(child)
  }

  return node
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

function computeWidths(node: TNode): void {
  if (node.children.length === 0) {
    node.width = 1
    return
  }
  for (const child of node.children) computeWidths(child)
  node.width = node.children.reduce((s, c) => s + c.width, 0)
}

function assignX(node: TNode, left: number): void {
  if (node.children.length === 0) {
    node.x = left
    return
  }
  let cursor = left
  for (const child of node.children) {
    assignX(child, cursor)
    cursor += child.width * STEP_X
  }
  node.x = (node.children[0].x + node.children[node.children.length - 1].x) / 2
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
  onClick: (msgId: string, threadId: string, isCurrent: boolean) => void,
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
      messageId: node.msg.id,
      threadId,
      isCurrentThread,
      onClick: () => onClick(node.msg.id, threadId, isCurrentThread),
    },
  })
  for (const child of node.children) {
    edges.push({
      id: `e-${node.id}-${child.id}`,
      source: node.id,
      target: child.id,
      isActive: node.isActive && child.isActive,
    })
    flatten(child, threadId, isCurrentThread, onClick, nodes, edges)
  }
}

function layoutThread(
  messages: Message[],
  forksHash: Record<string, MessageFork> | undefined,
  branchDepth: number | null,
  idPrefix: string,
  threadId: string,
  isCurrentThread: boolean,
  onClick: (msgId: string, threadId: string, isCurrent: boolean) => void
): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const root = buildTree(messages, forksHash, idPrefix, true, 0, branchDepth, 0, 0)
  if (!root) return { nodes: [], edges: [] }
  computeWidths(root)
  assignX(root, 0)
  const nodes: LayoutNode[] = []
  const edges: LayoutEdge[] = []
  flatten(root, threadId, isCurrentThread, onClick, nodes, edges)

  // Shift so the active branch is centered at x = 0
  const activeXs = nodes.filter((n) => n.data.isActive).map((n) => n.x)
  if (activeXs.length > 0) {
    const activeCenter = (Math.min(...activeXs) + Math.max(...activeXs)) / 2
    for (const n of nodes) n.x -= activeCenter
  }

  return { nodes, edges }
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

  const handleNodeClick = useCallback(
    (msgId: string, threadId: string, isCurrentThread: boolean) => {
      if (isCurrentThread) {
        const idx = session.messages.findIndex((m) => m.id === msgId)
        if (idx >= 0) scrollToIndex(idx, 'start', 'smooth')
      } else {
        void switchThreadAction(session.id, threadId)
      }
    },
    [session.id, session.messages]
  )

  const { flowNodes, flowEdges } = useMemo(() => {
    const allNodes: Node[] = []
    const allEdges: {
      id: string
      source: string
      target: string
      type: string
      animated: boolean
      style: object
    }[] = []

    let yOffset = 0

    const addThread = (
      msgs: Message[],
      forks: Record<string, MessageFork> | undefined,
      idPrefix: string,
      threadId: string,
      isCurrentThread: boolean,
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

      const { nodes, edges } = layoutThread(
        msgs, forks, branchDepth, idPrefix, threadId, isCurrentThread, handleNodeClick
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
          },
        })
      }

      const maxY = nodes.reduce((m, n) => Math.max(m, n.y), 0)
      yOffset += maxY + NODE_H + 60
    }

    addThread(session.messages, session.messageForksHash, 'cur_', session.id, true)

    if (session.threads) {
      for (const thread of session.threads) {
        addThread(
          thread.messages,
          thread.messageForksHash,
          `th_${thread.id}_`,
          thread.id,
          false,
          thread.name || 'Archived thread'
        )
      }
    }

    return { flowNodes: allNodes, flowEdges: allEdges }
  }, [session, branchDepth, handleNodeClick])

  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges)

  useEffect(() => { setNodes(flowNodes) }, [flowNodes, setNodes])
  useEffect(() => { setEdges(flowEdges) }, [flowEdges, setEdges])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 shrink-0">
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
          className="bg-gray-50"
        >
          <Controls showInteractive={false} />
          <Background color="#e5e7eb" gap={20} size={1} />
        </ReactFlow>
      </div>
    </div>
  )
}
