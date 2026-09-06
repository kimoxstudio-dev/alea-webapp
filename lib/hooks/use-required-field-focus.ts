import { useCallback, useRef } from 'react'

type FocusableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
type RefCallback = (el: FocusableElement | null) => void

/**
 * Shared "which required field is blank, focus it" mechanism for admin
 * forms (#313 code-review finding 5). Five admin sections
 * (club-events-section, equipment-section, library-games-section,
 * partners-section, rooms-section) each independently reimplemented "scan
 * required fields on submit, return which one is blank, focus it, show an
 * inline error" with three different data shapes for the error itself (a
 * discriminated union with a schedule-row index, a flat field name, a
 * `Partial<Record>`).
 *
 * This hook centralizes only what those five copies had genuinely
 * identical: a ref per field key, and focusing a field by key after a
 * failed submit. It deliberately does NOT own error state or validation —
 * what counts as "blank" (and how the error is shaped) varies per form and
 * stays a per-form concern; each caller keeps its own validator and its own
 * `useState` for the error to show.
 *
 * `getRef` hands out a STABLE ref callback per field key (cached across
 * renders), not a new inline arrow function on every render — the latter
 * forces React to detach/reattach the DOM ref on every keystroke (#313
 * code-review finding 4).
 *
 * `TField` defaults to `string` so a form with dynamic keys (e.g. a
 * schedule row's `schedule:${index}:${field}`) can use it directly, while a
 * form with a fixed field set can narrow it (e.g. `useRequiredFieldFocus<
 * 'name'>()`) for compile-time key checking at `getRef`/`focus` call sites.
 */
export function useRequiredFieldFocus<TField extends string = string>() {
  const fieldRefs = useRef<Partial<Record<TField, FocusableElement | null>>>({})
  const refCallbacks = useRef<Partial<Record<TField, RefCallback>>>({})

  const getRef = useCallback((field: TField): RefCallback => {
    const cached = refCallbacks.current[field]
    if (cached) return cached
    const callback: RefCallback = (el) => {
      fieldRefs.current[field] = el
    }
    refCallbacks.current[field] = callback
    return callback
  }, [])

  const focus = useCallback((field: TField) => {
    fieldRefs.current[field]?.focus()
  }, [])

  return { getRef, focus }
}
