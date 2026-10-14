/**
 * Inline stroke icons from the UI prototype. Decorative only: every icon sits next to visible text or inside a
 * control that has its own accessible name, so all of them are aria-hidden.
 */
import type { ReactNode } from 'react';

function Icon({
  size = 16,
  strokeWidth = 1.6,
  children,
}: {
  size?: number;
  strokeWidth?: number;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const CodeIcon = ({ size }: { size?: number }) => (
  <Icon size={size ?? 13} strokeWidth={2.2}>
    <path d="M6 4L2 8l4 4M10 4l4 4-4 4" />
  </Icon>
);

export const FileIcon = () => (
  <Icon size={18} strokeWidth={1.5}>
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2z" />
    <path d="M9 2v4h4" />
  </Icon>
);

export const ProblemsIcon = () => (
  <Icon size={18} strokeWidth={1.5}>
    <path d="M3 4h10M3 8h10M3 12h6" />
  </Icon>
);

export const FolderIcon = () => (
  <Icon size={22} strokeWidth={1.4}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </Icon>
);

export const MonitorIcon = () => (
  <Icon size={22} strokeWidth={1.4}>
    <rect x="2" y="3" width="12" height="8" rx="1" />
    <path d="M6 14h4M8 11v3" />
  </Icon>
);

export const StopIcon = () => (
  <Icon size={10} strokeWidth={2.4}>
    <rect x="4" y="4" width="8" height="8" rx="1" />
  </Icon>
);

/** Dashed circle: "not checked yet" — distinct in shape from a check mark or a warning triangle. */
export const UncheckedIcon = () => (
  <Icon size={13} strokeWidth={1.6}>
    <circle cx="8" cy="8" r="6" strokeDasharray="2 2" />
  </Icon>
);

export const DotIcon = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
    <circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

export const ChevronDownIcon = () => (
  <Icon size={14} strokeWidth={1.8}>
    <path d="M4 6l4 4 4-4" />
  </Icon>
);
