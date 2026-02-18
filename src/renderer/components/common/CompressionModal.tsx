import { Button, Stack, Text } from '@mantine/core'
import type { Session } from '@shared/types/session'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getContextMessagesForTokenEstimation } from '@/packages/context-management/context-tokens'
import { runCompactionWithUIState } from '@/packages/context-management/compaction'
import { generateSummary } from '@/packages/context-management/summary-generator'
import * as chatStore from '@/stores/chatStore'
import { compressAndCreateThread } from '@/stores/session'
import { AdaptiveModal } from './AdaptiveModal'

interface CompressionModalProps {
  opened: boolean
  onClose: () => void
  session: Session
}

export function CompressionModal({ opened, onClose, session }: CompressionModalProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)

  const handleCompressInPlace = () => {
    onClose()
    void runCompactionWithUIState(session.id, { force: true })
  }

  const handleCompressNewThread = async () => {
    setLoading(true)
    onClose()
    const mergedSettings = await chatStore.getSessionSettings(session.id)
    const messages = getContextMessagesForTokenEstimation(session, { settings: mergedSettings })
    const result = await generateSummary({ messages, sessionSettings: session.settings })
    if (result.success && result.summary) {
      await compressAndCreateThread(session.id, result.summary)
    }
    setLoading(false)
  }

  return (
    <AdaptiveModal opened={opened} onClose={onClose} title={t('Compress Conversation')} centered size="md">
      <Stack gap="md">
        <Text>
          {t('Summarize the conversation to free up context window space.')}
        </Text>
        <AdaptiveModal.Actions>
          <AdaptiveModal.CloseButton onClick={onClose} />
          <Button variant="default" onClick={handleCompressInPlace} disabled={loading}>
            {t('Compress in place')}
          </Button>
          <Button onClick={handleCompressNewThread} loading={loading}>
            {t('Compress + New Thread')}
          </Button>
        </AdaptiveModal.Actions>
      </Stack>
    </AdaptiveModal>
  )
}
