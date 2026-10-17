/**
 * A team's status in words, and the shape and letter its marker and badge
 * carry beside the colour (BRD:FR-03.04, WCAG 1.4.1): two statuses never
 * share both a shape and a letter, so nothing on the board depends on colour.
 */
import type { MapPoint } from '../ui/map.ts';

export const STATUS_TEXT: Record<string, string> = {
  available: 'Available',
  en_route: 'En route',
  on_task: 'On task',
  break: 'On break',
  out_of_service: 'Out of service',
  overdue: 'Overdue check-in',
};

export interface StatusMark {
  shape: MapPoint['shape'];
  mark: string;
  tone: MapPoint['tone'];
}

export const STATUS_MARK: Record<string, StatusMark> = {
  available: { shape: 'circle', mark: 'A', tone: 'ok' },
  en_route: { shape: 'diamond', mark: 'E', tone: 'busy' },
  on_task: { shape: 'square', mark: 'T', tone: 'busy' },
  break: { shape: 'circle', mark: 'B', tone: 'info' },
  out_of_service: { shape: 'square', mark: 'X', tone: 'danger' },
  overdue: { shape: 'triangle', mark: '!', tone: 'danger' },
};

/** The mark for a status; a status the board does not know reads as "?" rather than a colour. */
export function statusMark(status: string | null | undefined): StatusMark {
  return STATUS_MARK[status ?? ''] ?? { shape: 'circle', mark: '?', tone: 'info' };
}
