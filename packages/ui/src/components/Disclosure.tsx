/** A native details/summary with a 44 px summary; open state is the element's own. */
import type { ReactNode } from 'react';

export function Disclosure({
  summary,
  children,
  defaultOpen,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details
      className={['cg-disclosure', className ?? ''].filter(Boolean).join(' ')}
      open={defaultOpen}
    >
      <summary>{summary}</summary>
      <div>{children}</div>
    </details>
  );
}
