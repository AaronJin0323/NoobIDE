/**
 * Inline stroke icons from the UI prototype. Decorative only: every icon sits next to visible text or inside a
 * control that has its own accessible name, so all of them are aria-hidden.
 */
import type { ReactNode } from 'react';
import type { SaveStatus } from './save-machine';

/** Allowed rendered sizes (calm design spec, Icons): 14 inline, 16 default, 18 rail, 32 empty states. */
export const ICON_SIZES = [14, 16, 18, 32] as const;
/** Every outline icon renders ~1.5 px of stroke at its size; the viewBox is 16 units wide. */
export const ICON_STROKE_PX = 1.5;

/** The shared outline-icon base: a 16-unit viewBox whose stroke width is scaled to ~1.5 px at the rendered size. */
export function IconBase({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={(ICON_STROKE_PX * 16) / size}
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
  <IconBase size={size ?? 14}>
    <path d="M6 4L2 8l4 4M10 4l4 4-4 4" />
  </IconBase>
);

export const FileIcon = () => (
  <IconBase size={18}>
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2z" />
    <path d="M9 2v4h4" />
  </IconBase>
);

export const ProblemsIcon = () => (
  <IconBase size={18}>
    <path d="M3 4h10M3 8h10M3 12h6" />
  </IconBase>
);

export const FolderIcon = () => (
  <IconBase size={32}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </IconBase>
);

export const MonitorIcon = () => (
  <IconBase size={32}>
    <rect x="2" y="3" width="12" height="8" rx="1" />
    <path d="M6 14h4M8 11v3" />
  </IconBase>
);

export const StopIcon = () => (
  <IconBase size={14}>
    <rect x="4" y="4" width="8" height="8" rx="1" />
  </IconBase>
);

/** Dashed circle: "not checked yet" — distinct in shape from a check mark or a warning triangle. */
export const UncheckedIcon = () => (
  <IconBase size={14}>
    <circle cx="8" cy="8" r="6" strokeDasharray="2 2" />
  </IconBase>
);

export const DotIcon = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
    <circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

export const ChevronDownIcon = () => (
  <IconBase size={14}>
    <path d="M4 6l4 4 4-4" />
  </IconBase>
);

export const RevealIcon = () => (
  <IconBase size={16}>
    <path d="M9 3h4v4M13 3L7 9" />
    <path d="M12 10v2.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H6" />
  </IconBase>
);

export const SmallFolderIcon = () => (
  <IconBase size={16}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </IconBase>
);

export const WarningIcon = ({ size = 14 }: { size?: number }) => (
  <IconBase size={size}>
    <path d="M8 2.5l6 11H2z" />
    <path d="M8 7v3M8 12v.01" />
  </IconBase>
);

/** One shape per save state, so the state never depends on colour alone (AGENTS.md accessibility). */
export function SaveStateIcon({ state }: { state: SaveStatus }) {
  switch (state) {
    case 'clean':
      return (
        <IconBase size={14}>
          <circle cx="8" cy="8" r="5.5" />
        </IconBase>
      );
    case 'saved':
      return (
        <IconBase size={14}>
          <path d="M3 8.5l3 3 7-7" />
        </IconBase>
      );
    case 'dirty':
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <circle cx="5" cy="5" r="4" fill="currentColor" />
        </svg>
      );
    case 'saving':
      return (
        <IconBase size={14}>
          <path d="M13 8a5 5 0 1 1-1.5-3.5" />
          <path d="M13 2.5v3h-3" />
        </IconBase>
      );
    case 'failed':
      return <WarningIcon />;
    case 'conflict':
      return (
        <IconBase size={14}>
          <path d="M4 2v5a3 3 0 0 0 3 3h5M12 14V9" />
          <path d="M10 8l2 2-2 2" />
        </IconBase>
      );
    case 'deleted': // S11.3: a page with a cross — the file is gone from disk
      return (
        <IconBase size={14}>
          <path d="M4 1.5h5l3 3v10H4z" />
          <path d="M6 8l4 4M10 8l-4 4" />
        </IconBase>
      );
  }
}

export const CloseIcon = () => (
  <IconBase size={14}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </IconBase>
);

export const MinusIcon = () => (
  <IconBase size={14}>
    <path d="M3.5 8h9" />
  </IconBase>
);

export const PlusIcon = () => (
  <IconBase size={14}>
    <path d="M3.5 8h9M8 3.5v9" />
  </IconBase>
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
  <IconBase size={14}>
    <path d="M10 3.5L5.5 8l4.5 4.5" />
  </IconBase>
);

// ── S08: file tree ──────────────────────────────────────────────────────────────────────────────────────────────

/** Points right when closed; CSS rotates it when the folder is open (shape, not colour, shows the state). */
export const ChevronRightIcon = () => (
  <IconBase size={14}>
    <path d="M6 4l4 4-4 4" />
  </IconBase>
);

export const TreeFolderIcon = ({ open }: { open: boolean }) => (
  <IconBase size={16}>
    {open ? (
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4A1.5 1.5 0 0 1 13.5 6v.5H5.2a1.5 1.5 0 0 0-1.4 1L2 12.5zM2 12.5l1.8-5A1.5 1.5 0 0 1 5.2 6.5H15l-2 6a1 1 0 0 1-1 .5H3a1 1 0 0 1-1-.5z" />
    ) : (
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    )}
  </IconBase>
);

export const TreeFileIcon = () => (
  <IconBase size={16}>
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2z" />
    <path d="M9 2v4h4" />
  </IconBase>
);

export const LinkIcon = () => (
  <IconBase size={14}>
    <path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.6.6M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.6-.6" />
  </IconBase>
);

export const NewFileIcon = () => (
  <IconBase size={16}>
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14H8M9 2l4 4v2M9 2v4h4" />
    <path d="M12 10v4M10 12h4" />
  </IconBase>
);

export const NewFolderIcon = () => (
  <IconBase size={16}>
    <path d="M8 13H3.5A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v2" />
    <path d="M12 10v4M10 12h4" />
  </IconBase>
);

// S21.3: local history (clock with a back arrow)
export const HistoryIcon = ({ size = 18 }: { size?: number }) => (
  <IconBase size={size}>
    <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
    <path d="M2.5 2.5v2.5H5" />
    <path d="M8 5v3l2 1.5" />
  </IconBase>
);

/** S40.5: the command search in the top bar and the palette's search field. */
export const SearchIcon = ({ size }: { size?: number }) => (
  <IconBase size={size ?? 16}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </IconBase>
);

/** Key-features pass: the rail's "Lessons" button (an open book). */
export const LessonsIcon = () => (
  <IconBase size={18}>
    <path d="M8 4.5C6.8 3.5 5 3 2.5 3v9c2.5 0 4.3.5 5.5 1.5 1.2-1 3-1.5 5.5-1.5V3C11 3 9.2 3.5 8 4.5z" />
    <path d="M8 4.5v9" />
  </IconBase>
);

/** Key-features pass: the top bar's Save button (a tray with a down arrow). */
export const SaveIcon = () => (
  <IconBase size={16}>
    <path d="M8 2.5v7M5 6.5l3 3 3-3" />
    <path d="M2.5 10.5v1.5A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
  </IconBase>
);

// ── S46.7: glyphs that used to be inline in components ─────────────────────────────────────────────────────────

/** Preview "Run" (a filled play triangle; the label next to it carries the meaning). */
export const PlayIcon = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" />
  </svg>
);

/** Preview "Refresh": a circular arrow. */
export const RefreshIcon = () => (
  <IconBase size={14}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />
  </IconBase>
);

/** The Annotate entry: a pencil. */
export const PencilIcon = () => (
  <IconBase size={16}>
    <path d="M2.5 13.5l1-3.6 7.3-7.3a1.6 1.6 0 0 1 2.3 0l.3.3a1.6 1.6 0 0 1 0 2.3l-7.3 7.3z" />
    <path d="M9.6 3.8l2.6 2.6" />
  </IconBase>
);

/** A bulleted list (the annotations list toggle). */
export const ListIcon = () => (
  <IconBase size={14}>
    <path d="M6 4h8M6 8h8M6 12h8M2.5 4h.1M2.5 8h.1M2.5 12h.1" />
  </IconBase>
);

/** A check mark (e.g. an annotation's source was found). */
export const CheckIcon = () => (
  <IconBase size={14}>
    <path d="M3 8.5l3.2 3L13 4.5" />
  </IconBase>
);

/** "About right": two waves (e.g. an annotation's source was found approximately). */
export const ApproximateIcon = () => (
  <IconBase size={14}>
    <path d="M3 6.5c1.6-1.4 3.4-1.4 5 0s3.4 1.4 5 0M3 10.5c1.6-1.4 3.4-1.4 5 0s3.4 1.4 5 0" />
  </IconBase>
);

/** A circle with an exclamation mark (e.g. an annotation's source was not found). */
export const NoticeIcon = () => (
  <IconBase size={14}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.8v3.8M8 11.2v.1" />
  </IconBase>
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

// ── S51.3 find in files: the option toggles (shape, not colour, shows what each does) ──
/** Match case: a capital and a small letter A. */
export const CaseIcon = () => (
  <IconBase size={16}>
    <path d="M1.5 12.5L4.5 3.5l3 9M2.6 9.5h3.8" />
    <circle cx="11.5" cy="10.5" r="2" />
    <path d="M13.5 8v4.5" />
  </IconBase>
);

/** Whole word: a word between two bars, underlined. */
export const WholeWordIcon = () => (
  <IconBase size={16}>
    <path d="M1.5 4v6M14.5 4v6M1.5 13h13" />
    <path d="M4.5 9.5l1-4 1.25 3 1.25-3 1 4M10.5 6v3.5" />
  </IconBase>
);

/** Regular expression: a dot and an asterisk. */
export const RegexIcon = () => (
  <IconBase size={16}>
    <circle cx="3.5" cy="12" r="1" />
    <path d="M11 2.5v7M8 4.25l6 3.5M14 4.25l-6 3.5" />
  </IconBase>
);

/** Replace: a curved arrow from one line to the next. */
export const ReplaceIcon = () => (
  <IconBase size={16}>
    <path d="M3 3.5h6.5a3 3 0 0 1 0 6H5" />
    <path d="M7 7.5l-2 2 2 2" />
    <path d="M3 13h10" />
  </IconBase>
);
