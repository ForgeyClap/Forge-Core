/**
 * RouteSkipLine — one calm line on a routed reply: which router steps were skipped and why (Q6-UI, C1).
 *
 * "Overgeslagen: Mijn vLLM (Eigen API niet beschikbaar: verwijderd, uitgezet of geweigerd); Groq (kosten nog niet bevestigd)". It is
 * information, not an alarm: body-2 ink, the small text size, the quiet route icon. Shown under the route
 * notice of the answer (also when there is no notice at all) and under the "nothing could take this turn"
 * notice. Nothing is rendered when nothing was skipped.
 */

import { Icon } from '@/components/primitives';
import type { MessageKey } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import type { ChatRouteSkip } from '@/prototype/state/gateway-chat/live-activity';

const REASON_KEY: Record<ChatRouteSkip['reason'], MessageKey | null> = {
  provider_unavailable: 'chat.route.skipped.unavailable',
  paid_ack_required: 'chat.route.skipped.paidAck',
  unknown: null,
};

export function RouteSkipLine({ skipped }: { readonly skipped: readonly ChatRouteSkip[] }) {
  const { t } = useLocale();
  if (skipped.length === 0) return null;
  const items = skipped
    .map((skip) => {
      const key = REASON_KEY[skip.reason];
      return key === null ? skip.label : t(key, { label: skip.label });
    })
    .join('; ');
  return (
    <p className="fw-route-skip" role="note" aria-label={t('chat.route.skipped.label')} data-count={skipped.length}>
      <Icon name="Waypoints" size="xs" className="fw-route-skip__icon" />
      <span>{t('chat.route.skipped.line', { items })}</span>
    </p>
  );
}
