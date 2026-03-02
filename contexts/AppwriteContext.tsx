'use client'

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { useRouter, usePathname } from 'next/navigation'

interface AppwriteUser {
  id: string
  email: string
  name: string
}

interface AppwriteContextValue {
  user: AppwriteUser | null
  loading: boolean
  logout: () => Promise<void>
}

const AppwriteContext = createContext<AppwriteContextValue>({
  user: null,
  loading: true,
  logout: async () => {},
})

export function AppwriteProvider({ children }: { children: ReactNode }) {
  const router   = useRouter()
  const pathname = usePathname()
  const [user, setUser]       = useState<AppwriteUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.id) {
          setUser(data)
        } else if (pathname !== '/login') {
          router.push('/login')
        }
      })
      .catch(() => {
        if (pathname !== '/login') router.push('/login')
      })
      .finally(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    sessionStorage.removeItem('appwrite-session')
    setUser(null)
    router.push('/login')
  }, [router])

  return (
    <AppwriteContext.Provider value={{ user, loading, logout }}>
      {children}
    </AppwriteContext.Provider>
  )
}

export function useAppwrite() {
  return useContext(AppwriteContext)
}
