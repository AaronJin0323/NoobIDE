/** IME owns candidate selection/cancellation, including the boundary key reported as legacy code 229. */
export function isImeKey(event: { readonly isComposing?: boolean; readonly keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
