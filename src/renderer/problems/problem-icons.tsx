/**
 * Problem severity icons. Decorative (aria-hidden): every icon sits next to a text label such as "错误" / "Error",
 * so severity is never shown by colour or shape alone.
 */
import type { ReactNode } from 'react';
import type { ProblemSeverity } from '../../shared/problem';

function Svg({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
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
