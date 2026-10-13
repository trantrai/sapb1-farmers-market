import { useEffect, useRef } from 'react'

/**
 * Focus trap cho dialog: giữ Tab/Shift+Tab trong dialog, Escape để đóng.
 * Lưu phần tử đang focus khi mở và TRẢ FOCUS về đúng chỗ đó khi đóng (cleanup).
 * Trả về ref để gắn vào phần tử dialog.
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onEscape?: () => void,
) {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    if (!active) return
    const el = ref.current
    if (!el) return

    // Lưu nơi focus đang đứng trước khi mở dialog để trả lại khi đóng
    const prevFocused = document.activeElement as HTMLElement | null

    // Focus vào phần tử đầu tiên có thể focus trong dialog
    const focusables = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((n) => n.offsetParent !== null)

    const first = focusables()[0]
    if (first) first.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onEscape?.()
        return
      }
      if (e.key !== 'Tab') return
      const nodes = focusables()
      if (nodes.length === 0) return
      const firstNode = nodes[0]
      const lastNode = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === firstNode) {
        e.preventDefault()
        lastNode.focus()
      } else if (!e.shiftKey && document.activeElement === lastNode) {
        e.preventDefault()
        firstNode.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Trả focus về phần tử đã mở dialog (nếu còn trong DOM)
      if (prevFocused && document.contains(prevFocused)) {
        prevFocused.focus({ preventScroll: true })
      }
    }
  }, [active, onEscape])

  return ref
}
