/**
 * team-ui — presentation pieces shared by the Team strip and the Team screen (WP B4).
 *
 * Every visible word goes through the locale (`team.*` keys). The English log names ("Build Boss")
 * only render where `showLogName` is set, which only the Uitgebreid Team screen does
 * (PRODUCT-CARD.md: "Uitgebreid mag de Engelse namen uit de logboeken tonen"); those spans carry
 * `data-log-name` so the jargon test can tell log names from interface copy.
 */

import { Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import type { Locale, MessageKey } from '@/i18n';

import { ROLE_LOG_NAMES, ROLE_STAMPS } from './team-data';
import type { ChannelLine, RoleSlug, RoleStatus } from './team-data';

type TFn = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

export function roleName(t: TFn, role: RoleSlug | null): string {
  return role === null ? t('team.someone') : t(`team.roles.${role}`);
}

/** A name from the log: the role name when known, otherwise the raw name (Uitgebreid) or "Een helper". */
export function senderName(t: TFn, role: RoleSlug | null, raw: string | null, showLogName: boolean): string {
  if (role !== null) return roleName(t, role);
  return showLogName && raw ? raw : t('team.someone');
}

/** "A", "A en B", "A, B en C". */
export function joinNames(t: TFn, names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${t('team.and')} ${names[names.length - 1]}`;
}

export function formatClock(locale: Locale, iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

export function RoleStamp({ role, status, title }: { role: RoleSlug | null; status: RoleStatus; title?: string }) {
  return (
    <span className="fw-team-stamp" data-status={status} aria-hidden="true" title={title}>
      {role === null ? '?' : ROLE_STAMPS[role]}
    </span>
  );
}

export function LogName({ role, raw }: { role: RoleSlug | null; raw: string | null }) {
  const name = role !== null ? ROLE_LOG_NAMES[role] : raw;
  if (!name) return null;
  return (
    <span className="fw-team-logname" data-log-name="">
      {name}
    </span>
  );
}

const KIND_ICON: Readonly<Record<ChannelLine['kind'], string | null>> = {
  message: null,
  handoff: 'MoveRight',
  blocker: 'TriangleAlert',
  question: null,
  decision: 'Gavel',
};

export function KindBadge({ kind }: { kind: ChannelLine['kind'] }) {
  const { t } = useLocale();
  const icon = KIND_ICON[kind];
  return (
    <span className="fw-team-kind" data-kind={kind}>
      {kind === 'question' ? (
        <span className="fw-team-kind__q" aria-hidden="true">
          ?
        </span>
      ) : icon ? (
        <Icon name={icon} size="xs" />
      ) : null}
      {t(`team.kind.${kind}`)}
    </span>
  );
}

export function ViaLeadBadge() {
  const { t } = useLocale();
  return (
    <span className="fw-team-via" title={t('team.viaLeadHint')}>
      {t('team.viaLead')}
    </span>
  );
}

interface ChannelItemProps {
  readonly line: ChannelLine;
  readonly showLogName: boolean;
  readonly compact?: boolean;
}

/** One channel line: a handoff renders as a narrow system line, everything else as a message. */
export function ChannelItem({ line, showLogName, compact = false }: ChannelItemProps) {
  const { t, locale } = useLocale();
  const from = senderName(t, line.fromRole, line.from, showLogName);
  const to = line.to ? senderName(t, line.toRole, line.to, showLogName) : null;
  const clock = formatClock(locale, line.ts);

  if (line.kind === 'handoff') {
    const sentence =
      to === null
        ? from
        : showLogName && line.wpId
          ? t('team.handoffLine', { from, wp: line.wpId, to })
          : t('team.handoffLineNoTask', { from, to });
    return (
      <li className="fw-team-line fw-team-line--system" data-kind="handoff">
        <span className="fw-team-line__rule" aria-hidden="true" />
        <span className="fw-team-line__system">
          <Icon name="MoveRight" size="xs" />
          <span>{sentence}</span>
          {line.viaLead ? <ViaLeadBadge /> : null}
          {clock ? <time dateTime={line.ts ?? undefined}>{clock}</time> : null}
        </span>
        {line.text && !compact ? (
          <span className="fw-team-line__system-text" data-log-text="">
            {line.text}
          </span>
        ) : null}
        <span className="fw-team-line__rule" aria-hidden="true" />
      </li>
    );
  }

  return (
    <li className="fw-team-line" data-kind={line.kind} data-pinned={line.pinned ? 'true' : undefined} data-compact={compact ? 'true' : undefined}>
      <RoleStamp role={line.fromRole} status={line.kind === 'blocker' ? 'waiting' : 'done'} />
      <div className="fw-team-line__main">
        <div className="fw-team-line__head">
          <span className="fw-team-line__from">{from}</span>
          {to ? (
            <span className="fw-team-line__to">
              <Icon name="ArrowRight" size="xs" />
              {to}
            </span>
          ) : null}
          {showLogName ? <LogName role={line.fromRole} raw={line.from} /> : null}
          {line.kind !== 'message' ? <KindBadge kind={line.kind} /> : null}
          {line.viaLead ? <ViaLeadBadge /> : null}
          {showLogName && line.wpId ? (
            <span className="fw-team-line__wp" data-log-name="">
              {line.wpId}
            </span>
          ) : null}
          {clock ? (
            <time className="fw-team-line__time" dateTime={line.ts ?? undefined}>
              {clock}
            </time>
          ) : null}
        </div>
        <p className="fw-team-line__text" data-log-text="">
          {line.text}
        </p>
      </div>
    </li>
  );
}
