/**
 * Copies text for the "Copy code" button (S33.1). The workbench session denies permission requests (main/harden.ts),
 * so the async Clipboard API may be refused; the classic copy command on a temporary text area works from a click
 * without any permission. Resolves whether the text reached the clipboard.
 */
export async function copyText(text: string, doc: Document = document): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the copy command.
  }
  const active = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  doc.body.appendChild(area);
  try {
    area.select();
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    active?.focus();
  }
}
