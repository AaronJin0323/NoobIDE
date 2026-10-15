import { describe, expect, it } from 'vitest';
import { PermissionNotices, permissionKind } from './permission-policy';

describe('preview permission notices (S25.4)', () => {
  it('names what the page asked for', () => {
    expect(permissionKind('media', { mediaTypes: ['video'] })).toBe('camera');
    expect(permissionKind('media', { mediaTypes: ['audio'] })).toBe('microphone');
    expect(permissionKind('media', { mediaTypes: ['video', 'audio'] })).toBe('camera-microphone');
    expect(permissionKind('media')).toBe('camera-microphone');
    expect(permissionKind('media', { mediaTypes: [] })).toBe('screen'); // getDisplayMedia
    expect(permissionKind('geolocation')).toBe('location');
    expect(permissionKind('notifications')).toBe('notifications');
    expect(permissionKind('midi')).toBe('midi');
    expect(permissionKind('midiSysex')).toBe('midi');
    expect(permissionKind('clipboard-read')).toBe('clipboard');
    expect(permissionKind('clipboard-sanitized-write')).toBe('clipboard');
    expect(permissionKind('display-capture')).toBe('screen');
    for (const device of ['hid', 'serial', 'usb', 'bluetooth']) expect(permissionKind(device)).toBe('devices');
    expect(permissionKind('fullscreen')).toBe('fullscreen');
    expect(permissionKind('idle-detection')).toBe('other');
    expect(permissionKind('toString')).toBe('other'); // not an inherited property
  });

  it('explains each kind once per page load, as a localisable page notice that is never a problem', () => {
    const notices = new PermissionNotices();
    const first = notices.denied('media', { mediaTypes: ['video'] }, 5);
    expect(first).toEqual({
      source: 'page-load',
      level: 'warning',
      message: 'permission request denied: media',
      notice: { kind: 'permission-denied', permission: 'camera' },
      at: 5,
    });
    expect(notices.denied('media', { mediaTypes: ['video'] })).toBeNull(); // asked again: already explained
    expect(notices.denied('geolocation')?.notice).toEqual({ kind: 'permission-denied', permission: 'location' });
    notices.pageLoaded();
    expect(notices.denied('media', { mediaTypes: ['video'] })).not.toBeNull();
  });

  it('does not echo odd permission names into the record', () => {
    const notices = new PermissionNotices();
    expect(notices.denied('<img src=x>')?.message).toBe('permission request denied: unknown');
  });
});
