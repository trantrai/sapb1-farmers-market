import { useEffect, useRef } from 'react'

/**
 * Focus trap cho dialog: giữ Tab/Shift+Tab trong dialog, Escape để đóng.
 * Lưu phần tử đang focus khi mở và TRẢ FOCUS về đúng chỗ đó khi đóng (cleanup).
 * Trả về ref để gắn vào phần tử dialog.
 *
 * GUARD STACK: khi nhiều dialog cùng mở (vd modal form + ConfirmDialog),
 * chỉ dialog TRÊN CÙNG (mở sau nhất) xử lý phím — các dialog bên dưới
 * tạm nhường, tránh 2 trap cùng bắt Escape/Tab gây xung đột.
 */
const dialogStack: Array<{ id: number }> = []
let nextDialogId = 0

export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onEscape?: () => void,
) {
  const ref = useRef<T | null>(null)
  // Lưu onEscape vào ref để effect không re-run khi parent truyền inline function
  const onEscapeRef = useRef(onEscape)
  useEffect(() => {
    onEscapeRef.current = onEscape
  }, [onEscape])

  useEffect(() => {
    if (!active) return
    const el = ref.current
    if (!el) return

    // Đăng ký vào stack — dialog mở sau = trên cùng
    const entry = { id: ++nextDialogId }
    dialogStack.push(entry)
    const isTop = () => dialogStack.length > 0 && dialogStack[dialogStack.length - 1] === entry

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
      // Chỉ dialog trên cùng xử lý phím — dialog bên dưới tạm nhường
      if (!isTop()) return
      if (e.key === 'Escape') {
        onEscapeRef.current?.()
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
      // Rời stack khi đóng — dialog bên dưới (nếu còn) tự thành trên cùng
      const i = dialogStack.indexOf(entry)
      if (i >= 0) dialogStack.splice(i, 1)
      // Trả focus về phần tử đã mở dialog (nếu còn trong DOM)
      if (prevFocused && document.contains(prevFocused)) {
        prevFocused.focus({ preventScroll: true })
      }
    }
  }, [active])

  return ref
}
