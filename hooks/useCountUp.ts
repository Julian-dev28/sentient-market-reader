'use client'
import { useState, useEffect, useRef } from 'react'

/** Animates a number from its previous value to the new target using ease-out cubic. */
export function useCountUp(target: number, duration = 800): number {
  const [value, setValue] = useState(0)
  const rafRef  = useRef<number | undefined>(undefined)
  const fromRef = useRef(0)

  useEffect(() => {
    const from = fromRef.current
    const to   = target
    const t0   = performance.now()

    if (rafRef.current) cancelAnimationFrame(rafRef.current)

    const tick = (now: number) => {
      const t      = Math.min((now - t0) / duration, 1)
      const eased  = 1 - Math.pow(1 - t, 3)   // ease-out cubic
      const next   = from + (to - from) * eased
      fromRef.current = next
      setValue(next)
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [target, duration])

  return value
}
