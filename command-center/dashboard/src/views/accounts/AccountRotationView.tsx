/**
 * AccountRotationView — the account rotator's recommendation, read-only.
 *
 * Data: `GET /api/account-rotation` (`gateway/src/account-rotation.mjs`), built only from the
 * rotator's two token-free files (`~/.claude/FORGE_ACCOUNT_ROTATION.json` and a 'recommend'-phase
 * `forge-accounts/handoff.json`). This page cannot switch anything: in token mode a running session
 * keeps its own account, so the owner starts the next session with the recommended one.
 *
 * Honesty: a percentage is the rotator's own number or "—"; 'estimated', 'unknown' and
 * 'unmeasurable' readings are tagged as such, never shown as if they were live.
 */

import { Button, EmptyState, Eyebrow, Icon, Machine } from '@/components/primitives';
import { useAccountRotation } from '@/prototype/state/adapter/account-rotation';
import type { AccountRotation, RotatorAccount, RotatorAccountStatus, RotatorWindow } from '@/prototype/state/adapter/account-rotation';

import './accounts.css';

export const NOT_SET_UP_TITLE = 'Rotator not set up';

const STATUS_TEXT: Record<RotatorAccountStatus, { label: string; icon: string; hint: string }> = {
  live: { label: 'Live', icon: 'CircleCheck', hint: 'Measured in the last 15 minutes.' },
  estimated: { label: 'Estimated', icon: 'Clock', hint: 'Last-known numbers; a window that has reset since counts as 0%.' },
  unknown: { label: 'Unknown', icon: 'CircleDashed', hint: 'Never measured.' },
  unmeasurable: { label: 'Unmeasurable', icon: 'CircleSlash', hint: 'The usage endpoint refused this account’s token, so there is no number.' },
};

function formatPct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 10) / 10}%`;
}

function formatWhen(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatResetIn(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'reset due';
  const h = ms / 3_600_000;
  return h < 1 ? `resets in ${Math.max(1, Math.round(ms / 60_000))}m` : h < 24 ? `resets in ${Math.round(h)}h` : `resets in ${Math.round(h / 24)}d`;
}

function UsageWindow({ w, threshold }: { w: RotatorWindow; threshold: number }) {
  const pct = w.pct === null ? null : Math.max(0, Math.min(100, w.pct));
  const over = w.pct !== null && w.pct >= threshold;
  const reset = formatResetIn(w.resetsAt);
  return (
    <div className="fw-rot-window" data-over={over ? 'true' : 'false'}>
      <div className="fw-rot-window__row">
        <span className="fw-rot-window__label">{w.label}</span>
        <span className="fw-rot-window__value fg-machine">{formatPct(w.pct)}</span>
      </div>
      <div
        className="fw-rot-window__track"
        role="meter"
        aria-label={`${w.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={pct === null ? 'no reading' : `${formatPct(w.pct)}, switch threshold ${threshold}%`}
      >
        {pct !== null ? <span className="fw-rot-window__fill" style={{ inlineSize: `${pct}%` }} /> : null}
        <span className="fw-rot-window__threshold" style={{ insetInlineStart: `${threshold}%` }} title={`Switch threshold ${threshold}%`} />
      </div>
      {reset ? <span className="fw-rot-window__reset">{reset}</span> : null}
    </div>
  );
}

function AccountCard({ a, data }: { a: RotatorAccount; data: AccountRotation }) {
  const st = STATUS_TEXT[a.status];
  const isActive = data.active === a.name;
  const isRecommended = data.recommendation?.to === a.name;
  return (
    <li className="fw-rot-account" data-active={isActive ? 'true' : 'false'} data-recommended={isRecommended ? 'true' : 'false'}>
      <div className="fw-rot-account__head">
        <span className="fw-rot-account__name fw-truncate">{a.name}</span>
        {isActive ? <span className="fw-rot-tag" data-tone="active">Active</span> : null}
        {isRecommended ? <span className="fw-rot-tag" data-tone="next">Recommended</span> : null}
        <span className="fw-rot-status" data-status={a.status} title={st.hint}>
          <Icon name={st.icon} size="xs" />
          {st.label}
        </span>
      </div>
      {a.windows.length ? (
        <div className="fw-rot-account__windows">
          {a.windows.map((w, i) => <UsageWindow key={`${w.label}-${i}`} w={w} threshold={data.threshold} />)}
        </div>
      ) : (
        <p className="fw-rot-account__none">{a.status === 'unmeasurable' ? 'No reading: this account cannot be measured right now.' : 'No reading yet.'}</p>
      )}
      <div className="fw-rot-account__foot">
        {a.needsRelogin ? <span className="fw-rot-flag"><Icon name="CircleAlert" size="xs" />Needs a new login</span> : null}
        {formatWhen(a.measuredAt) ? <span>Measured {formatWhen(a.measuredAt)}</span> : null}
      </div>
    </li>
  );
}

function RecommendationCard({ data }: { data: AccountRotation }) {
  const rec = data.recommendation;
  if (!rec) {
    return (
      <section className="fw-rot-hero" data-state="steady" aria-label="Recommendation">
        <Eyebrow>Recommendation</Eyebrow>
        <p className="fw-rot-hero__line">No switch needed</p>
        <p className="fw-rot-hero__why">
          {data.active ? `${data.active} is below the ${data.threshold}% threshold, or no other account is usable.` : 'The rotator has not recorded a recommendation.'}
        </p>
      </section>
    );
  }
  const crossed = rec.trigger.map((t) => `${t.label} ${formatPct(t.pct)}`).join(', ');
  return (
    <section className="fw-rot-hero" data-state="recommend" aria-label="Recommendation">
      <Eyebrow>Recommended for the next session</Eyebrow>
      <p className="fw-rot-hero__line">
        {rec.from ? <><span className="fw-rot-hero__from">{rec.from}</span><Icon name="ArrowRight" size="md" className="fw-rot-hero__arrow" /></> : null}
        <span className="fw-rot-hero__to">{rec.to}</span>
      </p>
      <p className="fw-rot-hero__why">
        {crossed ? `${rec.from ?? 'The current account'} reached ${crossed}. ` : ''}
        {rec.why ? `Pick: ${rec.why}.` : ''}
        {formatWhen(rec.at) ? ` Recorded ${formatWhen(rec.at)}.` : ''}
      </p>
      <p className="fw-rot-hero__how">
        A running session keeps its own account. Start the next one with <Machine>account-rotator launch --auto</Machine>.
        {rec.source === 'handoff' ? ' (from the rotator’s handoff file)' : ''}
      </p>
    </section>
  );
}

export function AccountRotationPanel({ data }: { data: AccountRotation }) {
  return (
    <div className="fw-rot__grid">
      <RecommendationCard data={data} />
      <dl className="fw-rot-facts">
        <div><dt>Active account</dt><dd>{data.active ?? '—'}</dd></div>
        <div><dt>Switch threshold</dt><dd className="fg-machine">{data.threshold}%{data.thresholdIsDefault ? ' (default)' : ''}</dd></div>
        <div>
          <dt>Last switch</dt>
          <dd>
            {data.lastSwitch
              ? `${data.lastSwitch.from ?? '?'} → ${data.lastSwitch.to ?? '?'}${data.lastSwitch.reason ? ` · ${data.lastSwitch.reason}` : ''}${formatWhen(data.lastSwitch.at) ? ` · ${formatWhen(data.lastSwitch.at)}` : ''}`
              : 'None recorded'}
          </dd>
        </div>
        <div><dt>Updated</dt><dd>{formatWhen(data.updatedAt) ?? '—'}{data.mode ? ` · ${data.mode} mode` : ''}</dd></div>
      </dl>
      <section className="fw-rot-accounts" aria-label="Accounts">
        <Eyebrow>Accounts · {data.accounts.length}</Eyebrow>
        {data.accounts.length ? (
          <ul className="fw-rot-accounts__list">
            {data.accounts.map((a) => <AccountCard key={a.name} a={a} data={data} />)}
          </ul>
        ) : (
          <p className="fw-rot-account__none">The rotator has no enrolled accounts with readings yet.</p>
        )}
      </section>
    </div>
  );
}

export default function AccountRotationView() {
  const rot = useAccountRotation();
  let body: React.ReactNode;
  if (rot.status === 'loading') body = <EmptyState icon="Loader" title="Loading the rotator state…" />;
  else if (rot.status === 'error') {
    body = (
      <EmptyState
        icon="CircleAlert"
        title="Could not read the rotator state"
        detail={`The Command Center gateway answered: ${rot.error ?? 'no reason given'}.`}
        action={<Button size="sm" icon="RefreshCw" onClick={rot.reload}>Try again</Button>}
      />
    );
  } else if (!rot.value.setUp && rot.value.recommendation === null) {
    body = (
      <EmptyState
        icon="Gauge"
        title={rot.value.provenance === 'UNREADABLE' ? 'The rotator file could not be read' : NOT_SET_UP_TITLE}
        detail={
          rot.value.provenance === 'UNREADABLE'
            ? 'FORGE_ACCOUNT_ROTATION.json exists but is not valid. The rotator rewrites it on its next check.'
            : 'Enroll your Claude accounts with the account rotator; their usage and its recommendation then show up here.'
        }
      />
    );
  } else body = <AccountRotationPanel data={rot.value} />;

  return (
    <div className="fw-rot">
      <header className="fw-rot__head">
        <h1 className="fw-rot__title">Account rotation</h1>
        <p className="fw-rot__subtitle">
          Which Claude account to use next, and how full each one is. Read-only: only labels and percentages are read, never a login or token.
        </p>
      </header>
      {body}
    </div>
  );
}
