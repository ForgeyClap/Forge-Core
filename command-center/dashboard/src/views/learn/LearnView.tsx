/**
 * LearnView — Leer Forge (DESIGN.md §3.6, mockup 06-leer-forge): four bite-size lessons.
 *
 * Left: the lesson list (done lessons carry a green check, the open one is raised). Right: the lesson
 * card with an illustration, at most three steps, "Probeer het" (the real thing) and "Volgende les"
 * (or "Klaar" on the last lesson). Both mark the lesson done; progress lives in `forge.learn`, which the
 * sidebar's "2/4" reads. Lessons never block the app.
 */

import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Icon } from '@/components/primitives';
import { useLocale } from '@/i18n/use-locale';

import { firstOpenLesson, LESSONS, lessonById, lessonFromQuery, lessonTitleKey, markLessonDone, readDone } from './learn-model';
import type { LessonId } from './learn-model';
import { LessonCard } from './LessonCard';
import { useLessonAction } from './use-lesson-action';

import './learn.css';

export default function LearnView() {
  const { t } = useLocale();
  const [done, setDone] = useState<readonly LessonId[]>(() => readDone());
  // `/learn?lesson=limit` (the router's "Hoe werkt dit?") opens that lesson; otherwise the first open one.
  const [params] = useSearchParams();
  const requested = lessonFromQuery(params.get('lesson'));
  const [currentId, setCurrentId] = useState<LessonId>(() => requested?.id ?? firstOpenLesson(readDone()).id);
  // A new `?lesson=` while /learn is open (another "Hoe werkt dit?" click) opens that lesson too. Adjusted
  // during render, as React advises for state that follows a changed input.
  const [seenRequest, setSeenRequest] = useState(requested?.id);
  if (requested?.id !== seenRequest) {
    setSeenRequest(requested?.id);
    if (requested) setCurrentId(requested.id);
  }
  const refresh = useCallback(() => setDone(readDone()), []);
  const action = useLessonAction({ onProgress: refresh });

  const current = lessonById(currentId) ?? LESSONS[0];
  const index = LESSONS.indexOf(current);
  const last = index === LESSONS.length - 1;

  function finishCurrent() {
    setDone(markLessonDone(current.id));
    if (!last) setCurrentId(LESSONS[index + 1].id);
  }

  return (
    <div className="fs-learn">
      <header className="fs-learn__head">
        <h1 className="fs-learn__title">{t('rd.learn.title')}</h1>
        <p className="fs-learn__count" aria-live="polite">
          {t('rd.start.checklist.progress', { done: done.length, total: LESSONS.length })} {t('rd.chat.strip.done')}
        </p>
      </header>

      <div className="fs-learn__grid">
        <nav aria-label={t('rd.learn.title')}>
          <ol className="fs-learn__list">
            {LESSONS.map((lesson, position) => {
              const isDone = done.includes(lesson.id);
              const isCurrent = lesson.id === current.id;
              return (
                <li key={lesson.id}>
                  <button
                    type="button"
                    className="fs-learn__item"
                    aria-current={isCurrent ? 'step' : undefined}
                    data-done={isDone ? 'true' : undefined}
                    onClick={() => setCurrentId(lesson.id)}
                  >
                    <span className="fs-learn__num" aria-hidden="true">
                      {isDone ? <Icon name="Check" size="xs" /> : position + 1}
                    </span>
                    <span className="fs-learn__name">
                      {t(lessonTitleKey(lesson))}
                      {isDone ? <span className="fw-visually-hidden">{`, ${t('rd.learn.done')}`}</span> : null}
                    </span>
                    <span className="fs-learn__min">{t('rd.learn.minutes', { n: lesson.minutes })}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <LessonCard
          key={current.id}
          lesson={current}
          onTry={() => action.run(current)}
          onNext={finishCurrent}
          nextLabel={last ? t('rd.learn.done') : t('rd.learn.next')}
        />
      </div>
      {action.dialogs}
    </div>
  );
}
