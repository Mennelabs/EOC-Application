/** Which event, its hazard, its state and how long it has run (T+39h). */
import { elapsedLabel, humanize } from '../../format.ts';

export function EventChip({
  name,
  hazard,
  status,
  openedAt,
  now,
}: {
  name: string;
  hazard?: string | null;
  status?: string | null;
  openedAt?: string | null;
  now?: number;
}) {
  const parts = [
    hazard ? humanize(hazard) : null,
    status ? humanize(status) : null,
    elapsedLabel(openedAt, now),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="cg-event-chip">
      <span className="cg-event-chip__dot" aria-hidden="true" />
      <span className="cg-sr-only">Event: </span>
      <span className="cg-event-chip__name">{name}</span>
      {parts ? <span className="cg-event-chip__detail">{parts}</span> : null}
    </div>
  );
}
