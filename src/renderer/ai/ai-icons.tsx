import { IconBase } from '../workbench/icons';
import './ai-entry.css';

/**
 * Decorative icons of the AI surfaces (aria-hidden: each sits next to text or inside a named control). They share the
 * workbench icon base, so the stroke stays ~1.5 px at every allowed size (14 / 16 / 18 / 32): pass the size the icon
 * is shown at instead of resizing it in CSS.
 */
export const AiIcon = ({ size = 18 }: { size?: number }) => (
  <IconBase size={size}>
    <path d="M7 2.5l1.2 3.3 3.3 1.2-3.3 1.2L7 11.5 5.8 8.2 2.5 7l3.3-1.2z" />
    <path d="M12.5 10.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" />
  </IconBase>
);

export const CloseIcon = () => (
  <IconBase size={14}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </IconBase>
);

/** "New chat": a speech bubble with a plus. */
export const NewChatIcon = () => (
  <IconBase size={16}>
    <path d="M13.5 8.5a5 5 0 0 1-7.4 4.4L2.5 13.5l.8-3A5 5 0 1 1 13.5 8.5z" />
    <path d="M8.5 6v5M6 8.5h5" />
  </IconBase>
);

/** "Past chats": a clock. */
export const PastChatsIcon = () => (
  <IconBase size={16}>
    <circle cx={8} cy={8} r={5.5} />
    <path d="M8 5v3l2 1.5" />
  </IconBase>
);

/** "Explain this code": a speech bubble with a question mark. */
export const ExplainIcon = ({ size = 16 }: { size?: number }) => (
  <IconBase size={size}>
    <path d="M13.5 7.5c0 2.8-2.5 5-5.5 5-.8 0-1.6-.1-2.3-.4L2.5 13l.9-2.6A4.7 4.7 0 0 1 2.5 7.5c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5z" />
    <path d="M6.8 6.2a1.3 1.3 0 1 1 1.8 1.2c-.4.2-.6.5-.6.9v.2M8 10.2v.1" />
  </IconBase>
);
