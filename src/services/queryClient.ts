import { QueryClient } from '@tanstack/vue-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

const RELEASE_QUERY_KEYS = ['release', 'releases', 'dashboard', 'lineage', 'validations', 'events']

/** 其它窗口写入本地状态后，统一让当前窗口缓存失效，保证冲突立即可见 */
export const invalidateGovernanceQueries = async (): Promise<void> => {
  await Promise.all(
    RELEASE_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
  )
}
