import type { CompactionPoint, Message, Session, SessionSettings, SessionThread, Settings } from '@shared/types'
import { cleanToolCalls } from './tool-cleanup'

export interface BuildContextOptions {
  messages: Message[]
  compactionPoints?: CompactionPoint[]
  keepToolCallRounds?: number
  sessionSettings?: SessionSettings
  settings?: Partial<Settings>
}

/**
 * Builds context for AI by finding the latest compaction point, including the summary
 * message at the beginning, and applying tool call cleanup for older messages.
 * Falls back to all messages if no compaction points exist.
 *
 * Note: Messages with `generating: true` are excluded from context as they are incomplete.
 */
export function buildContextForAI(options: BuildContextOptions): Message[] {
  const { messages, compactionPoints, keepToolCallRounds = 2 } = options
  const contextRoles = options.sessionSettings?.highlightContextRoles

  const completedMessages = messages.filter((m) => !m.generating)

  if (completedMessages.length === 0) {
    return []
  }

  const applyRoleFilter = (msgs: Message[]) =>
    contextRoles ? msgs.filter((m) => contextRoles.includes(m.role as 'user' | 'assistant' | 'system')) : msgs

  const latestCompactionPoint = findLatestCompactionPoint(compactionPoints)

  if (!latestCompactionPoint) {
    return applyRoleFilter(cleanToolCalls(completedMessages, keepToolCallRounds))
  }

  const boundaryIndex = findMessageIndex(completedMessages, latestCompactionPoint.boundaryMessageId)
  const summaryMessage = findMessage(completedMessages, latestCompactionPoint.summaryMessageId)

  if (boundaryIndex === -1) {
    return applyRoleFilter(cleanToolCalls(completedMessages, keepToolCallRounds))
  }

  const messagesAfterBoundary = completedMessages.slice(boundaryIndex + 1).filter((m) => !m.isSummary)

  let contextMessages: Message[]
  if (summaryMessage) {
    contextMessages = [summaryMessage, ...messagesAfterBoundary]
  } else {
    contextMessages = messagesAfterBoundary
  }

  const systemMessage = completedMessages.find((m) => m.role === 'system')
  if (systemMessage && !contextMessages.some((m) => m.id === systemMessage.id)) {
    contextMessages = [systemMessage, ...contextMessages]
  }

  return applyRoleFilter(cleanToolCalls(contextMessages, keepToolCallRounds))
}

export function buildContextForSession(
  session: Session,
  options?: {
    threadId?: string
    keepToolCallRounds?: number
    settings?: Partial<Settings>
  }
): Message[] {
  const { threadId, keepToolCallRounds = 2, settings } = options ?? {}

  if (threadId && session.threads) {
    const thread = session.threads.find((t) => t.id === threadId)
    if (thread) {
      return buildContextForThread(thread, { keepToolCallRounds, sessionSettings: session.settings, settings })
    }
  }

  return buildContextForAI({
    messages: session.messages,
    compactionPoints: session.compactionPoints,
    keepToolCallRounds,
    sessionSettings: session.settings,
    settings,
  })
}

export function buildContextForThread(
  thread: SessionThread,
  options?: {
    keepToolCallRounds?: number
    sessionSettings?: SessionSettings
    settings?: Partial<Settings>
  }
): Message[] {
  const { keepToolCallRounds = 2, sessionSettings, settings } = options ?? {}

  return buildContextForAI({
    messages: thread.messages,
    compactionPoints: thread.compactionPoints,
    keepToolCallRounds,
    sessionSettings,
    settings,
  })
}

export function getContextMessageIds(session: Session, maxCount?: number): string[] {
  const contextMessages = buildContextForSession(session)
  const ids = contextMessages.map((m) => m.id)

  if (maxCount && maxCount > 0) {
    return ids.slice(-maxCount)
  }

  return ids
}

function findLatestCompactionPoint(compactionPoints?: CompactionPoint[]): CompactionPoint | undefined {
  if (!compactionPoints || compactionPoints.length === 0) {
    return undefined
  }

  return compactionPoints.reduce((latest, current) => {
    return current.createdAt > latest.createdAt ? current : latest
  })
}

function findMessageIndex(messages: Message[], messageId: string): number {
  return messages.findIndex((m) => m.id === messageId)
}

function findMessage(messages: Message[], messageId: string): Message | undefined {
  return messages.find((m) => m.id === messageId)
}
