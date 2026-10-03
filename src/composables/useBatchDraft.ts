import { ref } from 'vue'

const DRAFT_KEY = 'eventrail-batch-drafts-v1'

type DraftMap = Record<string, { text: string; savedAt: string }>

const loadDrafts = (): DraftMap => {
  try {
    return (JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') as DraftMap) ?? {}
  } catch {
    return {}
  }
}

/** 并发冲突时，后到窗口把未提交内容保留为端批次草稿 */
export const useBatchDraft = (batchId: () => string) => {
  const draftText = ref(loadDrafts()[batchId()]?.text ?? '')

  const persistDraft = (text: string): void => {
    const drafts = loadDrafts()
    drafts[batchId()] = { text, savedAt: new Date().toISOString() }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts))
    draftText.value = text
  }

  const clearDraft = (): void => {
    const drafts = loadDrafts()
    delete drafts[batchId()]
    localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts))
    draftText.value = ''
  }

  const draftSavedAt = (): string | undefined => loadDrafts()[batchId()]?.savedAt

  return { draftText, persistDraft, clearDraft, draftSavedAt }
}
