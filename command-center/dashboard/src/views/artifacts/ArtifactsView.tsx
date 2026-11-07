/**
 * Opgeleverd (/artifacts) — everything a klus delivered (DESIGN.md §3.3, §3.7).
 *
 * A title, a kind filter (only when more than one kind exists), and the items as list rows: a kind
 * tile, the file name, the kind word and size, and when it was made. Picking a row shows that item in
 * place with a way back: its recorded details, a readable body, and a real Download.
 *
 * Reads `state.data.artifacts` and `state.activeProjectId`. Download is a real anchor to
 * `GET /api/artifacts/:id/content` whenever an active project is known (build-lastdemos), an honest
 * disabled button otherwise. Screenshot and diagram records render as a described capture frame (the
 * recorded dimensions and size) rather than an inline image: fetching the bytes inline is a separate,
 * not-yet-built capability, named honestly instead of implied (fix-cert-claims).
 *
 * `redactDeep` (redact.mjs) covers JSON responses this gateway builds itself; a raw file download is the
 * user's own explicit request for those exact bytes and is intentionally NOT redacted.
 *
 * The markdown formatter below is deliberately tiny and local — headings, paragraphs, lists and inline
 * code. It is not shared with the chat view and it pulls in no dependency.
 */

import '../jobs/xpage.css';
import './artifacts.css';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

import { Button, ExampleTag, Icon, Machine } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { useGatewayArtifactsTruncated } from '@/prototype/state/gateway-adapter';
import { gatewayUrl } from '@/prototype/state/gateway-client';
import { usePrototype } from '@/prototype/state/prototype-store';
import type { Artifact, ArtifactKind } from '@/prototype/types/prototype-types';
import { useUiMode } from '@/state/ui-mode';
import { relativeWhen } from '@/views/jobs/when';
import { roleFromName } from '@/views/team/team-data';
import type { MessageKey } from '@/i18n';

/* ------------------------------------------------------------------ kinds */

const KINDS: readonly ArtifactKind[] = ['screenshot', 'report', 'diagram', 'markdown', 'log', 'receipt', 'proof'];

type KindFilter = ArtifactKind | 'all';

const KIND_ICONS: Readonly<Record<ArtifactKind, string>> = {
  screenshot: 'Image',
  report: 'ClipboardList',
  diagram: 'Workflow',
  markdown: 'FileText',
  log: 'ScrollText',
  receipt: 'Receipt',
  proof: 'ShieldCheck',
};

function kindKey(kind: KindFilter): MessageKey {
  return `rd.delivered.kind.${kind}` as MessageKey;
}

/* --------------------------------------------------------------- markdown */

type MarkdownBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] };

const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+\.\s+(.*)$/;

/**
 * Headings, paragraphs and lists. Anything else is treated as prose, which is
 * the honest failure mode for a formatter this small.
 */
function parseMarkdown(source: string): readonly MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };

  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ kind: 'list', ordered: listOrdered, items: listItems });
      listItems = [];
    }
  };

  for (const raw of source.split('\n')) {
    const line = raw.trim();

    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      if (listOrdered) flushList();
      listOrdered = false;
      listItems.push(bullet[1]);
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      flushParagraph();
      if (!listOrdered) flushList();
      listOrdered = true;
      listItems.push(numbered[1]);
      continue;
    }

    // An indented continuation of the item above it — the example documents
    // wrap their list items across lines.
    if (listItems.length > 0 && paragraph.length === 0 && /^\s{2,}\S/.test(raw)) {
      listItems[listItems.length - 1] = `${listItems[listItems.length - 1]} ${line}`;
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

/** `code` → <Machine>, **bold** → <strong>, *italic* → <em>. Nothing else. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  const out: ReactNode[] = [];
  let cursor = 0;
  let seq = 0;
  let match = pattern.exec(text);

  while (match) {
    if (match.index > cursor) out.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyBase}-inline-${seq}`;
    seq += 1;

    if (token.startsWith('`')) {
      out.push(<Machine key={key}>{token.slice(1, -1)}</Machine>);
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }

    cursor = match.index + token.length;
    match = pattern.exec(text);
  }

  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function MarkdownBody({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);

  return (
    <div className="fw-artifacts__md">
      {blocks.map((block, index) => {
        const key = `block-${index}`;

        if (block.kind === 'heading') {
          const content = renderInline(block.text, key);
          if (block.level <= 1) {
            return (
              <h3 key={key} className="fw-artifacts__md-h1">
                {content}
              </h3>
            );
          }
          if (block.level === 2) {
            return (
              <h4 key={key} className="fw-artifacts__md-h2">
                {content}
              </h4>
            );
          }
          return (
            <h5 key={key} className="fw-artifacts__md-h3">
              {content}
            </h5>
          );
        }

        if (block.kind === 'list') {
          const items = block.items.map((item, itemIndex) => (
            <li key={`${key}-item-${itemIndex}`}>{renderInline(item, `${key}-item-${itemIndex}`)}</li>
          ));
          return block.ordered ? (
            <ol key={key} className="fw-artifacts__md-list">
              {items}
            </ol>
          ) : (
            <ul key={key} className="fw-artifacts__md-list">
              {items}
            </ul>
          );
        }

        return (
          <p key={key} className="fw-artifacts__md-p">
            {renderInline(block.text, key)}
          </p>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------- capture frame */

const DIMENSIONS = /(\d{3,4})\s*[x×]\s*(\d{3,4})/;

/**
 * F2 (fix-cert-claims): this note once claimed "no image file exists behind this record", which was
 * false whenever a real agent produced the artifact (the gateway reports a real, `stat()`'d size). The
 * download route now exists; what is still not built is rendering the bytes inline, and that is what
 * the note says (artifact-capture-frame-honesty.test.tsx).
 */
function CaptureFrame({ artifact }: { artifact: Artifact }) {
  const { t } = useLocale();
  const found = DIMENSIONS.exec(artifact.preview);
  const width = found ? Number(found[1]) : null;
  const height = found ? Number(found[2]) : null;
  const ratio = width && height ? `${width} / ${height}` : '16 / 10';

  return (
    <figure className="fw-artifacts__frame">
      <div className="fw-artifacts__frame-box" style={{ '--fw-artifacts-ratio': ratio } as CSSProperties}>
        <Icon name={artifact.kind === 'diagram' ? 'Workflow' : 'ImageOff'} size="lg" />
        <span className="fw-artifacts__frame-dims">
          {width && height ? <Machine muted>{`${width} × ${height}`}</Machine> : t('rd.delivered.noDims')}
        </span>
        <p className="fw-artifacts__frame-note">{t('rd.delivered.frameNote')}</p>
      </div>
      <figcaption className="fw-artifacts__frame-caption">{artifact.preview}</figcaption>
    </figure>
  );
}

/**
 * feat-chatruns-tabs: a chat-run-derived artifact carries the chat-run id (`chat-<conversation>-<turn>`)
 * in `producedBy`. It is a file the dashboard chat edited directly, never a stored artifact copy, so the
 * content route has nothing to serve and the Download stays honestly disabled.
 */
function isChatRunArtifact(artifact: Artifact): boolean {
  return artifact.producedBy.startsWith('chat-');
}

/**
 * "Gemaakt door", the same way JobDetail names a helper: the role word for a known helper ("Bouwer"),
 * "Een gesprek" for a file a dashboard chat edited, and otherwise the name as the log recorded it (in
 * mono, it is machine text). After a role word the log name only shows in Uitgebreid.
 */
function MadeBy({ artifact }: { readonly artifact: Artifact }) {
  const { t } = useLocale();
  const { isAdvanced } = useUiMode();
  if (isChatRunArtifact(artifact)) return <>{t('rd.delivered.byChat')}</>;
  const role = roleFromName(artifact.producedBy);
  // Not a helper we know (often a run id): the recorded name as machine text, never hidden.
  if (role === null) return <Machine data-log-name>{artifact.producedBy}</Machine>;
  return (
    <>
      {t(`team.roles.${role}`)}
      {isAdvanced ? (
        <Machine muted className="fw-artifacts__logname" title={artifact.producedBy} data-log-name>
          {artifact.producedBy}
        </Machine>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- filter bar */

interface KindFilterBarProps {
  readonly options: readonly KindFilter[];
  readonly value: KindFilter;
  readonly onChange: (value: KindFilter) => void;
}

function KindFilterBar({ options, value, onChange }: KindFilterBarProps) {
  const { t } = useLocale();
  const groupRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = options.indexOf(value);
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(options[next]);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div
      ref={groupRef}
      className="fw-artifacts__filters"
      role="radiogroup"
      aria-label={t('rd.delivered.filterLabel')}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const selected = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className="fw-artifacts__filter"
            onClick={() => onChange(option)}
          >
            {t(kindKey(option))}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- preview */

interface PreviewProps {
  readonly artifact: Artifact;
  readonly projectId: string;
  readonly onClose: () => void;
}

function DownloadControl({ artifact, projectId }: { readonly artifact: Artifact; readonly projectId: string }) {
  const { t } = useLocale();
  if (isChatRunArtifact(artifact)) {
    return (
      <Button size="sm" variant="secondary" icon="Download" disabled title={t('rd.delivered.downloadChat')}>
        {t('rd.delivered.download')}
      </Button>
    );
  }
  if (projectId === '') {
    return (
      <Button size="sm" variant="secondary" icon="Download" disabled title={t('rd.delivered.downloadNoProject')}>
        {t('rd.delivered.download')}
      </Button>
    );
  }
  return (
    <a
      className="fw-control fw-button fw-button--secondary fw-button--sm"
      href={gatewayUrl(`/api/artifacts/${encodeURIComponent(artifact.id)}/content?project=${encodeURIComponent(projectId)}`)}
      download={artifact.name}
    >
      <Icon name="Download" size="xs" className="fw-button__icon" />
      <span className="fw-button__label">{t('rd.delivered.download')}</span>
    </a>
  );
}

function Preview({ artifact, projectId, onClose }: PreviewProps) {
  const { t, locale } = useLocale();
  const created = relativeWhen(artifact.createdAt, locale);

  return (
    <article className="fw-artifacts__preview" aria-label={t('rd.delivered.previewOf', { name: artifact.name })}>
      <button type="button" className="fw-xpage__crumb" onClick={onClose}>
        <Icon name="ArrowLeft" size="xs" />
        {t('rd.delivered.title')}
      </button>

      <header className="fw-artifacts__preview-head">
        <span className="fw-xtile" aria-hidden="true">
          <Icon name={KIND_ICONS[artifact.kind]} size="sm" />
        </span>
        <h1 className="fw-artifacts__preview-name">{artifact.name}</h1>
        <ExampleTag text={t('rd.states.example')} detail={t('rd.states.example')} />
        <DownloadControl artifact={artifact} projectId={projectId} />
      </header>

      <dl className="fw-artifacts__meta">
        <div className="fw-artifacts__meta-row">
          <dt>{t('rd.delivered.by')}</dt>
          <dd>
            <MadeBy artifact={artifact} />
          </dd>
        </div>
        <div className="fw-artifacts__meta-row">
          <dt>{t('rd.delivered.task')}</dt>
          <dd>
            <Machine muted={artifact.taskId === null}>{artifact.taskId ?? '—'}</Machine>
          </dd>
        </div>
        <div className="fw-artifacts__meta-row">
          <dt>{t('rd.delivered.created')}</dt>
          <dd title={artifact.createdAt}>{created !== '' ? created : <Machine>{artifact.createdAt}</Machine>}</dd>
        </div>
        <div className="fw-artifacts__meta-row">
          <dt>{t('rd.delivered.size')}</dt>
          <dd>{artifact.size}</dd>
        </div>
      </dl>

      <div className="fw-artifacts__body">
        {artifact.kind === 'markdown' || artifact.kind === 'report' ? (
          <MarkdownBody source={artifact.preview} />
        ) : artifact.kind === 'screenshot' || artifact.kind === 'diagram' ? (
          <CaptureFrame artifact={artifact} />
        ) : (
          <pre className="fw-artifacts__output fg-machine">{artifact.preview}</pre>
        )}
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------- view */

function ArtifactRow({ artifact, onSelect }: { readonly artifact: Artifact; readonly onSelect: () => void }) {
  const { t, locale } = useLocale();
  const when = relativeWhen(artifact.createdAt, locale);
  return (
    <li>
      <div className="fw-xrow fw-artifacts__row">
        <button type="button" className="fw-xrow__main" onClick={onSelect}>
          <span className="fw-xtile" aria-hidden="true">
            <Icon name={KIND_ICONS[artifact.kind]} size="sm" />
          </span>
          <span className="fw-xrow__text">
            <span className="fw-xrow__name">
              <span className="fw-xrow__name-text">{artifact.name}</span>
            </span>
            <span className="fw-xrow__sub">
              {t(kindKey(artifact.kind))} · {artifact.size}
            </span>
          </span>
        </button>
        <span className="fw-xrow__when" title={artifact.createdAt}>
          {when !== '' ? when : artifact.createdAt}
        </span>
        <Icon name="ChevronRight" size="sm" className="fw-xrow__chev" />
      </div>
    </li>
  );
}

export default function ArtifactsView() {
  const { state, dispatch } = usePrototype();
  const { t } = useLocale();
  const artifacts = state.data.artifacts;
  // WP-RB-CC (L-1): true once the gateway's own scan hit its bound, so the list honestly may not be
  // complete. See useGatewayArtifactsTruncated.
  const artifactsTruncated = useGatewayArtifactsTruncated(state.activeProjectId);
  const [kind, setKind] = useState<KindFilter>('all');

  const presentKinds = useMemo(() => KINDS.filter((k) => artifacts.some((artifact) => artifact.kind === k)), [artifacts]);
  const filterOptions = useMemo<readonly KindFilter[]>(() => ['all', ...presentKinds], [presentKinds]);
  const activeKind: KindFilter = kind === 'all' || presentKinds.includes(kind) ? kind : 'all';
  const shown = activeKind === 'all' ? artifacts : artifacts.filter((artifact) => artifact.kind === activeKind);

  const selectedId = state.selection.kind === 'artifact' ? state.selection.id : null;
  const selected = selectedId ? (artifacts.find((artifact) => artifact.id === selectedId) ?? null) : null;

  const select = useCallback(
    (artifact: Artifact) => dispatch({ type: 'select', selection: { kind: 'artifact', id: artifact.id } }),
    [dispatch],
  );
  const close = useCallback(() => dispatch({ type: 'select', selection: { kind: 'none' } }), [dispatch]);

  if (selected !== null) {
    return (
      <div className="fw-xpage fw-artifacts">
        <div className="fw-xpage__body fw-artifacts__page">
          <Preview artifact={selected} projectId={state.activeProjectId} onClose={close} />
        </div>
      </div>
    );
  }

  return (
    <div className="fw-xpage fw-artifacts">
      <header className="fw-xpage__header">
        <div className="fw-xpage__title">
          <h1>{t('rd.delivered.title')}</h1>
        </div>
      </header>

      <div className="fw-xpage__body">
        {artifacts.length === 0 ? (
          <div className="fw-xpage__empty">
            <p>{t('rd.projects.deliveredEmpty')}</p>
          </div>
        ) : (
          <>
            {presentKinds.length > 1 ? <KindFilterBar options={filterOptions} value={activeKind} onChange={setKind} /> : null}
            {shown.length === 0 ? (
              <div className="fw-xpage__empty">
                <p>{t('rd.delivered.noneOfKind')}</p>
                <Button variant="quiet" icon="RotateCcw" onClick={() => setKind('all')}>
                  {t('rd.delivered.showAll')}
                </Button>
              </div>
            ) : (
              <ul className="fw-xlist fw-artifacts__list" aria-label={t('rd.delivered.title')}>
                {shown.map((artifact) => (
                  <ArtifactRow key={artifact.id} artifact={artifact} onSelect={() => select(artifact)} />
                ))}
              </ul>
            )}
            {artifactsTruncated ? (
              <p className="fw-xpage__note">
                <Icon name="Info" size="sm" />
                {t('rd.delivered.truncated')}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
