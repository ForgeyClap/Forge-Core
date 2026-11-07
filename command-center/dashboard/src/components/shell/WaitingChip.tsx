/**
 * WaitingChip — the real, global "a session is waiting on you" indicator (feat-live-visibility,
 * Gap A: "a waiting question is invisible outside its own conversation").
 *
 * Mounted in the Topbar (present on every route via AppShell), next to the existing
 * `ClaudeCodeChip` — the same "small, honest, always-reachable chip" surface that chip already
 * establishes, rather than a new fixed-position overlay corner. Renders NOTHING when there is no
 * genuinely pending ask (mirrors `ConnectionBanner`'s "healthy state has no chrome" convention) —
 * this must never claim a wait that isn't real, and must never hide one that is.
 *
 * SCOPE: the ACTIVE project only — see `gateway-pending-asks.ts`'s own header for why. Clicking
 * jumps straight to the conversation that asked (the FIRST pending ask when more than one
 * conversation in this project is genuinely waiting at once).
 */

import { useNavigate } from 'react-router-dom';

import { Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { usePrototype } from '@/prototype/state/prototype-store';
import { useGatewayPendingAsks } from '@/prototype/state/gateway-pending-asks';

import './waiting-chip.css';

export function WaitingChip() {
  const { state, dispatch } = usePrototype();
  const navigate = useNavigate();
  const { t } = useLocale();
  const pending = useGatewayPendingAsks(state.activeProjectId);

  if (pending.length === 0) return null;

  const first = pending[0];
  const more = pending.length - 1;
  const excerpt = first.conversationFirstMessage;
  const title =
    (excerpt !== null ? t('shell.waiting.titleWithExcerpt', { excerpt }) : t('shell.waiting.titleNoText')) +
    (more > 0 ? t(more === 1 ? 'shell.waiting.moreOne' : 'shell.waiting.moreMany', { count: more }) : '');

  function jumpToConversation() {
    dispatch({ type: 'conversation/activate', id: first.conversationId });
    navigate('/chat');
  }

  return (
    <button type="button" className="fw-waiting" onClick={jumpToConversation} title={title}>
      <Icon name="MessageSquare" size="xs" className="fw-waiting__icon" />
      {/* Plain body text: "Wacht op jou" is a sentence for the owner, not machine text (DESIGN.md §2). */}
      <span className="fw-waiting__text">
        <span className="fw-waiting__part">{t('shell.waiting.label')}</span>
        {pending.length > 1 ? <span className="fw-waiting__count">{pending.length}</span> : null}
      </span>
    </button>
  );
}

export default WaitingChip;
