import type { HTMLAttributes, ReactNode } from 'react';
import { useRovingFocus, type RovingFocusOptions } from './useRovingFocus';

/**
 * S49.2: a `<div>` with roving focus over its own buttons, for rows rendered in a list (one hook per row) or owned by
 * another feature's markup (the chat add-context group, the proposal action rows): swapping the element adds the
 * keyboard behaviour without touching the row's look.
 */
export function RovingGroup({
  orientation = 'horizontal',
  loop,
  rtl,
  items,
  skipHidden,
  children,
  ...rest
}: RovingFocusOptions & Omit<HTMLAttributes<HTMLDivElement>, 'onKeyDown' | 'onFocus'> & { children?: ReactNode }) {
  const roving = useRovingFocus<HTMLDivElement>({
    orientation,
    ...(loop === undefined ? {} : { loop }),
    ...(rtl === undefined ? {} : { rtl }),
    ...(items === undefined ? {} : { items }),
    ...(skipHidden === undefined ? {} : { skipHidden }),
  });
  return (
    <div {...rest} {...roving}>
      {children}
    </div>
  );
}
