/**
 * LessonCard — one Leer Forge lesson (DESIGN.md §3.6): an illustration built from the real component
 * shapes, the title, at most 3 short steps, and the actions.
 *
 * "Probeer het" always does the real thing (see `useLessonAction`). It also marks the lesson done,
 * because trying it is the lesson. Used full-size on /learn and compact in the `?` side pane.
 */

import { useId } from 'react';

import { Button, Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';
import { usePrototype } from '@/prototype/state/prototype-store';

import { lessonStepKeys, lessonTitleKey } from './learn-model';
import type { Lesson } from './learn-model';

function ArtComposer() {
  const { t } = useLocale();
  return (
    <div className="fs-learn-art fs-learn-art--composer">
      <span className="fs-learn-art__text">{t('rd.start.placeholder')}</span>
      <span className="fs-learn-art__row">
        <Icon name="Plus" size="sm" />
        <span className="fs-learn-art__send">
          <Icon name="ArrowUp" size="sm" />
        </span>
      </span>
    </div>
  );
}

function ArtProject() {
  const { t } = useLocale();
  // The tile shows a real project: the active one. With no project yet it is a quiet bar, never a second
  // "Nieuw project" (review L8) and never an invented name.
  const { state } = usePrototype();
  const projectName = state.activeProjectId.trim();
  return (
    <div className="fs-learn-art fs-learn-art--project">
      <span className="fs-learn-art__tile">
        <Icon name="Folder" size="sm" />
      </span>
      {projectName ? (
        <span className="fs-learn-art__name fs-learn-art__name--project">{projectName}</span>
      ) : (
        <i className="fs-learn-art__bar fs-learn-art__bar--short" />
      )}
      <span className="fs-learn-art__button">{t('rd.projects.new')}</span>
    </div>
  );
}

function ArtProof() {
  const { t } = useLocale();
  return (
    <div className="fs-learn-art fs-learn-art--proof">
      <span className="fs-learn-art__pin fs-learn-art__pin--1">1</span>
      <span className="fs-learn-art__pin fs-learn-art__pin--2">2</span>
      <span className="fs-learn-art__head">
        <span className="fs-learn-art__stamp">
          <Icon name="BadgeCheck" size="sm" />
        </span>
        <b>{t('rd.chat.proof.title')}</b>
      </span>
      {/* Check lines as quiet bars: the illustration shows the shape, it never invents a test. */}
      <span className="fs-learn-art__check">
        <Icon name="Check" size="xs" />
        <i className="fs-learn-art__bar" />
      </span>
      <span className="fs-learn-art__check">
        <Icon name="Check" size="xs" />
        <i className="fs-learn-art__bar fs-learn-art__bar--short" />
      </span>
    </div>
  );
}

function ArtLimit() {
  const { t } = useLocale();
  return (
    <div className="fs-learn-art fs-learn-art--limit">
      <span className="fs-learn-art__name">{t('rd.settings.router.ask')}</span>
      <span className="fs-learn-art__select">
        {t('rd.settings.router.claudeThenOwn')}
        <Icon name="ChevronDown" size="xs" />
      </span>
      <span className="fs-learn-art__sub">{t('rd.settings.router.tellsYou')}</span>
    </div>
  );
}

const ART = {
  first: ArtComposer,
  project: ArtProject,
  proof: ArtProof,
  limit: ArtLimit,
} as const;

export interface LessonCardProps {
  readonly lesson: Lesson;
  /** Runs the lesson's real action ("Probeer het"). */
  readonly onTry: () => void;
  /** "Volgende les" (or "Klaar" on the last lesson). Omitted in the side pane. */
  readonly onNext?: () => void;
  readonly nextLabel?: string;
  /** The side pane: no illustration, a smaller title. */
  readonly compact?: boolean;
}

export function LessonCard({ lesson, onTry, onNext, nextLabel, compact = false }: LessonCardProps) {
  const { t } = useLocale();
  const titleId = useId();
  const Art = ART[lesson.key];
  const Heading = compact ? 'h3' : 'h2';
  return (
    <article className={compact ? 'fs-lesson fs-lesson--compact' : 'fs-lesson'} aria-labelledby={titleId} data-lesson={lesson.id}>
      {compact ? null : (
        <div className="fs-lesson__art" aria-hidden="true">
          <Art />
        </div>
      )}
      <div className="fs-lesson__body">
        <Heading id={titleId} className="fs-lesson__title">
          {t(lessonTitleKey(lesson))}
        </Heading>
        <ol className="fs-lesson__steps">
          {lessonStepKeys(lesson).map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ol>
        <div className="fs-lesson__actions">
          <Button variant="primary" icon="Play" onClick={onTry} size={compact ? 'sm' : 'md'}>
            {t('rd.learn.try')}
          </Button>
          {onNext && nextLabel ? (
            <Button variant="secondary" onClick={onNext}>
              {nextLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
