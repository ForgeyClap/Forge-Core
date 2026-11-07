/**
 * HelpLessons — gives the shell's `?` side pane the lesson for the current page (DESIGN.md §3.6:
 * "the `?` side pane on every page, which opens the matching lesson"). Renders nothing itself; it
 * registers a renderer through `registerHelpLesson` while mounted. Pages without a matching lesson get
 * the pane's own fallback line (a link to Leer Forge), never an invented lesson.
 */

import { useEffect } from 'react';

import { registerHelpLesson, setHelpView } from '@/components/shell/side-pane';

import { lessonForPath } from './learn-model';
import { LessonCard } from './LessonCard';
import { useLessonAction } from './use-lesson-action';

import './learn.css';

function PaneLesson({ path }: { readonly path: string }) {
  const action = useLessonAction({ onLeave: () => setHelpView('closed') });
  const lesson = lessonForPath(path);
  if (!lesson) return null;
  return (
    <>
      <LessonCard lesson={lesson} onTry={() => action.run(lesson)} compact />
      {action.dialogs}
    </>
  );
}

export function HelpLessons() {
  useEffect(
    () => registerHelpLesson((path) => (lessonForPath(path) ? <PaneLesson path={path} /> : null)),
    [],
  );
  return null;
}
