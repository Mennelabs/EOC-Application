/** A tooltip names an icon-only control for sighted people; the control's aria-label names it for everyone else. */
import type { ReactNode } from 'react';
import { OverlayArrow, Tooltip as AriaTooltip, TooltipTrigger } from 'react-aria-components';

export function Tooltip({ children, text }: { children: ReactNode; text: string }) {
  return (
    <TooltipTrigger delay={300}>
      {children}
      <AriaTooltip className="cg-tooltip" offset={6}>
        <OverlayArrow />
        {text}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
