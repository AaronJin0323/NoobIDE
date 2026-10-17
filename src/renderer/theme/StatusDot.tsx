/**
 * S47.4: a 6 px status dot that sits next to a state's word (never instead of it). `pulse` breathes its opacity over
 * --dur-pulse (1.2 s) while something is going on — the preview running, the AI thinking; it is static under reduced
 * motion (glass.css gate). Decorative: the word next to it carries the state.
 */
export function StatusDot({ pulse = false }: { readonly pulse?: boolean }) {
  return <span className="status-dot" data-pulse={pulse || undefined} aria-hidden="true" />;
}
