"use client"

import { useEffect, useRef } from "react"

/*
 * Counts a formatted figure up once when it scrolls into view. The server-rendered text is the
 * final value and stays in place without JavaScript or under reduced motion. Only the digits move;
 * "—", "1 MB" and "143 ms" keep their words.
 */
export function CountUp({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const node = ref.current
    const match = /^([\d,]+)(\.\d+)?([^]*)$/.exec(value)
    if (!node || !match || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const target = Number(match[1].replaceAll(",", "") + (match[2] ?? ""))
    if (!Number.isFinite(target) || target === 0) return

    const decimals = match[2] ? match[2].length - 1 : 0
    const grouped = match[1].includes(",")
    const render = (n: number) =>
      n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouped }) + match[3]

    let frame = 0
    const run = () => {
      const start = performance.now()
      const tick = (now: number) => {
        const t = Math.min((now - start) / 800, 1)
        node.textContent = t === 1 ? value : render(target * (1 - (1 - t) ** 4))
        if (t < 1) frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        observer.disconnect()
        run()
      }
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      node.textContent = value
    }
  }, [value])

  return <span ref={ref}>{value}</span>
}
