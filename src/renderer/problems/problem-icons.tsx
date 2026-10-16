/**
 * Problem severity icons. Decorative (aria-hidden): every icon sits next to a text label such as "错误" / "Error",
 * so severity is never shown by colour or shape alone.
 */
import type { ReactNode } from 'react';
import type { ProblemSeverity } from '../../shared/problem';
import { IconBase } from '../workbench/icons';

/** 14 px glyphs on the shared icon base (S46.7: one ~1.5 px stroke for every outline icon). */
function Svg({ children }: { children: ReactNode }) {
  return <IconBase size={14}>{children}</IconBase>;
}

export const ErrorIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="6" />
    <path d="M6 6l4 4M10 6l-4 4" />
  </Svg>
);

export const WarnIcon = () => (
  <Svg>
    <path d="M8 2.5l6 11H2l6-11z" />
    <path d="M8 7v3M8 12v.01" />
  </Svg>
);

export const InfoIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.5v3.5M8 5v.01" />
  </Svg>
);

export const CheckIcon = () => (
  <Svg>
    <path d="M3 8.5l3 3 7-7" />
  </Svg>
);

export function SeverityIcon({ severity }: { severity: ProblemSeverity }) {
  if (severity === 'error') return <ErrorIcon />;
  if (severity === 'warning') return <WarnIcon />;
  return <InfoIcon />;
}
