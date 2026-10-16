/**
 * Inline stroke icons from the UI prototype. Decorative only: every icon sits next to visible text or inside a
 * control that has its own accessible name, so all of them are aria-hidden.
 */
import type { ReactNode } from 'react';
import type { SaveStatus } from './save-machine';

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

export const RevealIcon = () => (
  <Icon size={15} strokeWidth={1.5}>
    <path d="M9 3h4v4M13 3L7 9" />
    <path d="M12 10v2.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H6" />
  </Icon>
);

export const SmallFolderIcon = () => (
  <Icon size={15} strokeWidth={1.5}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </Icon>
);

export const WarningIcon = ({ size = 13 }: { size?: number }) => (
  <Icon size={size} strokeWidth={1.8}>
    <path d="M8 2.5l6 11H2z" />
    <path d="M8 7v3M8 12v.01" />
  </Icon>
);

/** One shape per save state, so the state never depends on colour alone (AGENTS.md accessibility). */
export function SaveStateIcon({ state }: { state: SaveStatus }) {
  switch (state) {
    case 'clean':
      return (
        <Icon size={13} strokeWidth={1.6}>
          <circle cx="8" cy="8" r="5.5" />
        </Icon>
      );
    case 'saved':
      return (
        <Icon size={13} strokeWidth={2.2}>
          <path d="M3 8.5l3 3 7-7" />
        </Icon>
      );
    case 'dirty':
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <circle cx="5" cy="5" r="4" fill="currentColor" />
        </svg>
      );
    case 'saving':
      return (
        <Icon size={13} strokeWidth={2}>
          <path d="M13 8a5 5 0 1 1-1.5-3.5" />
          <path d="M13 2.5v3h-3" />
        </Icon>
      );
    case 'failed':
      return <WarningIcon />;
    case 'conflict':
      return (
        <Icon size={13} strokeWidth={1.8}>
          <path d="M4 2v5a3 3 0 0 0 3 3h5M12 14V9" />
          <path d="M10 8l2 2-2 2" />
        </Icon>
      );
    case 'deleted': // S11.3: a page with a cross — the file is gone from disk
      return (
        <Icon size={13} strokeWidth={1.8}>
          <path d="M4 1.5h5l3 3v10H4z" />
          <path d="M6 8l4 4M10 8l-4 4" />
        </Icon>
      );
  }
}

export const CloseIcon = () => (
  <Icon size={12} strokeWidth={1.8}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

export const MinusIcon = () => (
  <Icon size={13} strokeWidth={1.8}>
    <path d="M3.5 8h9" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon size={13} strokeWidth={1.8}>
    <path d="M3.5 8h9M8 3.5v9" />
  </Icon>
);

/** "More" (three dots): opens a small panel of further actions. */
export const MoreIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
    <circle cx="8" cy="8" r="1.4" fill="currentColor" />
    <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
  </svg>
);

/** Points left (e.g. "more tabs this way"). */
export const ChevronLeftIcon = () => (
  <Icon size={12} strokeWidth={1.8}>
    <path d="M10 3.5L5.5 8l4.5 4.5" />
  </Icon>
);

// ── S08: file tree ──────────────────────────────────────────────────────────────────────────────────────────────

/** Points right when closed; CSS rotates it when the folder is open (shape, not colour, shows the state). */
export const ChevronRightIcon = () => (
  <Icon size={12} strokeWidth={1.8}>
    <path d="M6 4l4 4-4 4" />
  </Icon>
);

export const TreeFolderIcon = ({ open }: { open: boolean }) => (
  <Icon size={15} strokeWidth={1.4}>
    {open ? (
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4A1.5 1.5 0 0 1 13.5 6v.5H5.2a1.5 1.5 0 0 0-1.4 1L2 12.5zM2 12.5l1.8-5A1.5 1.5 0 0 1 5.2 6.5H15l-2 6a1 1 0 0 1-1 .5H3a1 1 0 0 1-1-.5z" />
    ) : (
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    )}
  </Icon>
);

export const TreeFileIcon = () => (
  <Icon size={15} strokeWidth={1.4}>
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2z" />
    <path d="M9 2v4h4" />
  </Icon>
);

export const LinkIcon = () => (
  <Icon size={12} strokeWidth={1.6}>
    <path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.6.6M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.6-.6" />
  </Icon>
);

export const NewFileIcon = () => (
  <Icon size={15} strokeWidth={1.5}>
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14H8M9 2l4 4v2M9 2v4h4" />
    <path d="M12 10v4M10 12h4" />
  </Icon>
);

export const NewFolderIcon = () => (
  <Icon size={15} strokeWidth={1.5}>
    <path d="M8 13H3.5A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v2" />
    <path d="M12 10v4M10 12h4" />
  </Icon>
);

// S21.3: local history (clock with a back arrow)
export const HistoryIcon = ({ size = 18 }: { size?: number }) => (
  <Icon size={size} strokeWidth={1.5}>
    <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
    <path d="M2.5 2.5v2.5H5" />
    <path d="M8 5v3l2 1.5" />
  </Icon>
);

/** S40.5: the command search in the top bar and the palette's search field. */
export const SearchIcon = ({ size }: { size?: number }) => (
  <Icon size={size ?? 15}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </Icon>
);

/** The NoobIDE mark without its tile ("< • >", resources/brand/noobide-mark.svg), in the current colour. */
export const NoobIdeMark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="172 172 680 680" aria-hidden="true" focusable="false">
    <g fill="none" stroke="currentColor" strokeWidth="88" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="356,352 216,512 356,672" />
      <polyline points="668,352 808,512 668,672" />
    </g>
    <circle cx="512" cy="512" r="64" fill="currentColor" />
  </svg>
);

/** The NoobIDE logo (resources/brand/noobide-logo.svg): accent tile with a "< • >" mark. Decorative. */
export const NoobIdeLogo = ({ size = 40 }: { size?: number }) => (
  <svg
    className="noobide-logo"
    width={size}
    height={size}
    viewBox="100 100 824 824"
    aria-hidden="true"
    focusable="false"
  >
    <rect className="noobide-logo-tile" x="100" y="100" width="824" height="824" rx="185" />
    <g className="noobide-logo-glyph" fill="none" strokeWidth="88" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="356,352 216,512 356,672" />
      <polyline points="668,352 808,512 668,672" />
      <circle cx="512" cy="512" r="64" stroke="none" />
    </g>
  </svg>
);
