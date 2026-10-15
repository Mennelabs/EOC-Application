/** Display-only pieces: pills, cards, tiles, notices, page headers, empty states, timelines. */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CircleAlert, CircleCheck, Info, Sparkles } from 'lucide-react';

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'ai';

/** A state in words with a tone; never colour alone (ACC-09). */
export function Pill({
  tone = 'neutral',
  dot,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={['cg-pill', `cg-pill--${tone}`, className ?? ''].filter(Boolean).join(' ')}>
      {dot ? <span className="cg-pill__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function Card({
  title,
  kicker,
  actions,
  children,
  flat,
  sunken,
  as: Tag = 'section',
  className,
  ...rest
}: {
  title?: ReactNode;
  kicker?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flat?: boolean;
  sunken?: boolean;
  as?: 'section' | 'div' | 'article' | 'li';
  className?: string;
  'aria-labelledby'?: string;
  'aria-label'?: string;
  id?: string;
}) {
  return (
    <Tag
      {...rest}
      className={[
        'cg-card',
        flat ? 'cg-card--flat' : '',
        sunken ? 'cg-card--sunken' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {title || actions ? (
        <div className="cg-card__head">
          <div>
            {kicker ? <div className="cg-card__kicker">{kicker}</div> : null}
            {title}
          </div>
          {actions ? <div className="cg-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Tag>
  );
}

/** One number, what it is, one line of detail (dashboards, the situation home). */
export function StatTile({
  label,
  value,
  unit,
  detail,
  tone,
  href,
  onNavigate,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  detail?: ReactNode;
  tone?: 'warn' | 'danger';
  href?: string;
  onNavigate?: (href: string) => void;
}) {
  const body = (
    <>
      <span className="cg-stat__label">{label}</span>
      <span className="cg-stat__value">
        {value}
        {unit ? <small> {unit}</small> : null}
      </span>
      {detail ? <p className="cg-stat__detail">{detail}</p> : null}
    </>
  );
  const cls = ['cg-stat', tone ? `cg-stat--${tone}` : ''].filter(Boolean).join(' ');
  if (href) {
    return (
      <a
        className={cls}
        href={href}
        onClick={(e) => {
          if (!onNavigate) return;
          e.preventDefault();
          onNavigate(href);
        }}
      >
        {body}
      </a>
    );
  }
  return <div className={cls}>{body}</div>;
}

export function Tiles({ children }: { children: ReactNode }) {
  return <div className="cg-tiles">{children}</div>;
}

export function PageHeader({
  title,
  lede,
  actions,
  id,
}: {
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <header className="cg-page-header">
      <div>
        <h1 id={id}>{title}</h1>
        {lede ? <p className="cg-page-header__lede">{lede}</p> : null}
      </div>
      {actions ? <div className="cg-page-header__actions">{actions}</div> : null}
    </header>
  );
}

const NOTICE_ICONS: Record<Tone, LucideIcon> = {
  neutral: Info,
  info: Info,
  ok: CircleCheck,
  warn: AlertTriangle,
  danger: CircleAlert,
  ai: Sparkles,
};

/** A message with a tone. Errors are alerts; everything else is polite status. */
export function Notice({
  tone = 'info',
  title,
  children,
  role,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  role?: 'status' | 'alert' | 'none';
  className?: string;
}) {
  const Icon = NOTICE_ICONS[tone];
  const r = role ?? (tone === 'danger' ? 'alert' : 'status');
  return (
    <div
      className={['cg-notice', `cg-notice--${tone}`, className ?? ''].filter(Boolean).join(' ')}
      role={r === 'none' ? undefined : r}
    >
      <Icon className="cg-notice__icon" aria-hidden="true" />
      <div className="cg-notice__body">
        {title ? <strong>{title} </strong> : null}
        {children}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="cg-empty-state">
      {Icon ? <Icon aria-hidden="true" width={28} height={28} /> : null}
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Toolbar({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="cg-toolbar" role={label ? 'toolbar' : undefined} aria-label={label}>
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="cg-kbd">{children}</kbd>;
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="cg-sr-only">{children}</span>;
}

/** A shape while data loads; announced as nothing. */
export function Skeleton({ width = '100%', lines = 1 }: { width?: string; lines?: number }) {
  return (
    <span aria-hidden="true" style={{ display: 'grid', gap: '0.5rem' }}>
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className="cg-skeleton"
          style={{ inlineSize: i === lines - 1 ? width : '100%' }}
        />
      ))}
    </span>
  );
}

/** Something a named person must decide: kicker, title, one line, the actions. */
export function DecisionCard({
  kicker,
  title,
  tone,
  children,
  actions,
}: {
  kicker: ReactNode;
  title: ReactNode;
  tone?: 'warn' | 'danger' | 'ai';
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className={['cg-decision', tone ? `cg-decision--${tone}` : ''].filter(Boolean).join(' ')}>
      <div className="cg-decision__kicker">{kicker}</div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {actions ? <div className="cg-actions">{actions}</div> : null}
    </li>
  );
}

export function DecisionList({
  children,
  ...rest
}: {
  children: ReactNode;
  'aria-labelledby'?: string;
}) {
  return (
    <ul className="cg-decisions" {...rest}>
      {children}
    </ul>
  );
}

export interface TimelineEntry {
  id: string;
  time: string;
  /** ISO timestamp for the machine-readable datetime. */
  at?: string;
  source?: ReactNode;
  text: ReactNode;
}

export function Timeline({
  entries,
  ...rest
}: {
  entries: TimelineEntry[];
  'aria-labelledby'?: string;
}) {
  return (
    <ol className="cg-timeline" {...rest}>
      {entries.map((e) => (
        <li key={e.id}>
          <time dateTime={e.at}>{e.time}</time>
          <div>
            {e.source ? <div className="cg-timeline__source">{e.source}</div> : null}
            <div>{e.text}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
