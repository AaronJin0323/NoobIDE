import type { PreviewLogEntry, PreviewPermissionKind } from '../shared/ipc/preview-contract';

/**
 * Preview permissions (S25.4, PLAN §8): the page is untrusted, so every permission it asks for — camera, microphone,
 * location, notifications, MIDI, clipboard, screen capture, USB/HID/serial/Bluetooth devices, fullscreen, … — is
 * denied by the preview session (preview-manager.ts `configureSession`: request, check and device handlers, device
 * choosers). No OS prompt can appear: the request is answered in main before Chromium would ask the system.
 *
 * Beginners then see `getUserMedia` or `getCurrentPosition` fail without knowing why, so the first request of each
 * kind per page load becomes a non-blocking console notice (`notice.kind: 'permission-denied'`), which the workbench
 * shows in the user's language. Pure: no Electron.
 */

/** Chromium / Electron permission names → what the notice names. Unknown names are 'other'. */
const KINDS: Readonly<Record<string, PreviewPermissionKind>> = {
  geolocation: 'location',
  notifications: 'notifications',
  midi: 'midi',
  midiSysex: 'midi',
  'clipboard-read': 'clipboard',
  'clipboard-sanitized-write': 'clipboard',
  'display-capture': 'screen',
  hid: 'devices',
  serial: 'devices',
  usb: 'devices',
  bluetooth: 'devices',
  fullscreen: 'fullscreen',
};

export function permissionKind(
  permission: string,
  details?: { readonly mediaTypes?: readonly string[] | undefined },
): PreviewPermissionKind {
  if (permission === 'media') {
    const types = details?.mediaTypes;
    // getDisplayMedia arrives as 'media' with no camera or microphone (Electron lists only device capture).
    if (types && types.length === 0) return 'screen';
    const video = types?.includes('video') ?? false;
    const audio = types?.includes('audio') ?? false;
    if (video && !audio) return 'camera';
    if (audio && !video) return 'microphone';
    return 'camera-microphone';
  }
  return Object.hasOwn(KINDS, permission) ? (KINDS[permission] as PreviewPermissionKind) : 'other';
}

/** Chromium permission names are short ASCII identifiers; anything else is not echoed into a record. */
function safeName(permission: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(permission) ? permission : 'unknown';
}

/**
 * One notice per permission kind per page load: a page that asks again and again (a retry loop) does not fill the
 * console. `pageLoaded()` starts a new page load.
 */
export class PermissionNotices {
  private readonly reported = new Set<PreviewPermissionKind>();

  pageLoaded(): void {
    this.reported.clear();
  }

  /** The console notice for a denied request, or null when this kind was already explained for this page load. */
  denied(
    permission: string,
    details?: { readonly mediaTypes?: readonly string[] | undefined },
    at = Date.now(),
  ): PreviewLogEntry | null {
    const kind = permissionKind(permission, details);
    if (this.reported.has(kind)) return null;
    this.reported.add(kind);
    return {
      source: 'page-load',
      level: 'warning',
      // English fallback; the workbench shows the localised notice (preview.notice.permissionDenied).
      message: `permission request denied: ${safeName(permission)}`,
      notice: { kind: 'permission-denied', permission: kind },
      at,
    };
  }
}
