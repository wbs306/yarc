export const requestJson = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData
  const headers = new Headers(init.headers)
  if (!isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers,
  })
  const data = await response.json().catch(() => ({})) as { error?: { message?: string }; message?: string } | null
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `Request failed (${response.status})`)
  return data as T
}
