/**
 * useLessonAction — what "Probeer het" does per lesson (DESIGN.md §3.6). Every action is real:
 *
 *   start-with-example  Start, with an example request typed into the real Start composer (not sent)
 *   new-project         the real "Nieuw project" dialog (POST /api/projects), then the new project
 *   proof-list          Klussen & bewijs, the real list of runs and their proof
 *   router-settings     Instellingen, scrolled to "Als je limiet op is" (`?focus=router`)
 *
 * Trying a lesson marks it done. The hook returns `run(lesson)` and the dialog it may need, which the
 * caller renders.
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { NewProjectDialog } from '@/components/shell/NewProjectDialog';
import { usePrototype } from '@/prototype/state/prototype-store';
import { t as translateNow } from '@/i18n';

import { markLessonDone } from './learn-model';
import type { Lesson } from './learn-model';

/** How long the example waits for the Start composer to mount (a lazy route). */
const COMPOSER_WAIT_FRAMES = 120;

/**
 * The Start composer only. "Probeer het" can be pressed in the `?` pane on /chat, where the chat composer
 * (same `data-tour`, variant "chat") is still in the page right after `navigate('/')`; typing there would
 * put the example into a composer that is about to unmount. So the search waits for Start.
 */
const START_COMPOSER_FIELD = '[data-tour="composer"][data-variant="start"] textarea';

function findComposerField(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(START_COMPOSER_FIELD);
}

function nextFrame(callback: () => void): void {
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(callback);
  else window.setTimeout(callback, 16);
}

/**
 * Types `text` into the Start composer the way a person would (native value setter + input event), so the
 * composer's own state follows. It is never sent: the person reads it and presses Enter themselves.
 */
export function fillComposer(text: string, frames = COMPOSER_WAIT_FRAMES): void {
  let left = frames;
  const attempt = () => {
    const field = findComposerField();
    if (field) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();
      return;
    }
    left -= 1;
    if (left > 0) nextFrame(attempt);
  };
  attempt();
}

export interface LessonActionController {
  readonly run: (lesson: Lesson) => void;
  /** The "Nieuw project" dialog; render it once. */
  readonly dialogs: ReactNode;
}

export interface LessonActionOptions {
  /** Called right after the lesson is marked done (LearnView re-reads its progress). */
  readonly onProgress?: () => void;
  /** Called when the action leaves this place: a navigation, or the dialog closing (the side pane closes). */
  readonly onLeave?: () => void;
}

export function useLessonAction({ onProgress, onLeave }: LessonActionOptions = {}): LessonActionController {
  const navigate = useNavigate();
  const { dispatch } = usePrototype();
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const run = useCallback(
    (lesson: Lesson) => {
      markLessonDone(lesson.id);
      onProgress?.();
      if (lesson.action !== 'new-project') onLeave?.();
      switch (lesson.action) {
        case 'start-with-example':
          navigate('/');
          fillComposer(translateNow('rd.start.siteExample'));
          break;
        case 'new-project':
          setNewProjectOpen(true);
          break;
        case 'proof-list':
          navigate('/jobs');
          break;
        case 'router-settings':
          navigate('/settings?focus=router');
          break;
        default:
          break;
      }
    },
    [navigate, onProgress, onLeave],
  );

  const dialogs = (
    <NewProjectDialog
      open={newProjectOpen}
      onClose={() => {
        setNewProjectOpen(false);
        onLeave?.();
      }}
      onCreated={(id) => {
        setNewProjectOpen(false);
        onLeave?.();
        dispatch({ type: 'project/activate', id });
        navigate('/project');
      }}
    />
  );

  return { run, dialogs };
}
