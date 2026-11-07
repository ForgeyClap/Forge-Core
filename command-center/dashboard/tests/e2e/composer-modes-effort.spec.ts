/**
 * Mode/effort persistence across a real reload (test-e2e-composer).
 *
 * `Composer.tsx` persists the send-mode choice PER PROJECT (`forge.prototype.chatSendMode.<id>`)
 * and the effort choice globally (`forge.prototype.chatEffort`) in `localStorage`. This is real
 * browser storage, not application state — the only honest way to prove it survives is a real
 * `page.reload()` inside the same browser context, re-selecting the same project the way a person
 * actually would (the project itself is NOT remembered across a reload — re-selecting it is not an
 * artifact of this test, it is what re-seeds the per-project mode from storage). No conversation is
 * created and no message is ever sent by this spec.
 */

import { expect, test } from '@playwright/test';
import { blockedOwnerGatewayUrls, openComposerTray, openSandboxProject } from './live-gateway-helpers';

test.describe('composer mode/effort persistence', () => {
  // Fail closed: nothing in this spec may reach the developer's own gateway on 127.0.0.1:4100.
  test.afterEach(async ({ page }) => {
    expect(blockedOwnerGatewayUrls(page), 'the page tried to reach the live gateway on 127.0.0.1:4100').toEqual([]);
  });

  test('the selected send mode persists per project across a reload', async ({ page }) => {
    await openSandboxProject(page);
    await page.goto('/#/chat');
    await page.waitForLoadState('domcontentloaded');
    // Redesign: the mode and effort controls sit in the tray behind the composer's "+" (Add) button.
    await openComposerTray(page);

    // Plan: a non-default choice that needs no extra confirmation (Bypass does, see the slash spec), so
    // this test stays about per-project persistence only.
    const modeGroup = page.locator('.fw-chat-composer__mode');
    await modeGroup.getByRole('radio', { name: 'Plan' }).click();
    await expect(modeGroup.getByRole('radio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true');

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // Re-select the SAME project through the real sidebar search — activeProjectId itself is not
    // persisted across a reload, only the per-project mode choice is.
    await openSandboxProject(page);
    await page.goto('/#/chat');
    await page.waitForLoadState('domcontentloaded');
    // Redesign: the mode and effort controls sit in the tray behind the composer's "+" (Add) button.
    await openComposerTray(page);

    await expect(
      page.locator('.fw-chat-composer__mode').getByRole('radio', { name: 'Plan' }),
      'Plan mode did not survive a real reload for the same project',
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('a different project never inherits another project\'s stored send mode (Plan, chosen explicitly, does not leak)', async ({ page }) => {
    await openSandboxProject(page);
    await page.goto('/#/chat');
    await page.waitForLoadState('domcontentloaded');
    // Redesign: the mode and effort controls sit in the tray behind the composer's "+" (Add) button.
    await openComposerTray(page);
    // A fresh project's own default is Accept edits (`mode-storage.ts` DEFAULT_SEND_MODE), so this
    // isolation proof uses a DIFFERENT non-default choice ('Plan') — otherwise a second fresh project
    // landing on the default would be indistinguishable from "leaked" vs. "its own independent default".
    await page.locator('.fw-chat-composer__mode').getByRole('radio', { name: 'Plan' }).click();
    await expect(page.locator('.fw-chat-composer__mode').getByRole('radio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true');

    // Switching to a DIFFERENT small sandbox project with no stored choice of its own must read its
    // OWN default (Accept edits), never the first sandbox project's just-set Plan — this is the fix-sec-round #2 guarantee (`Composer.tsx`'s own header) that a sticky
    // mode choice cannot silently follow into an unrelated project. Deliberately another disposable
    // self-test project (never a project with real client work) for the same reason
    // `SANDBOX_PROJECT` itself is one.
    await openSandboxProject(page, 'dashboard-selftest');
    await page.goto('/#/chat');
    await page.waitForLoadState('domcontentloaded');
    // Redesign: the mode and effort controls sit in the tray behind the composer's "+" (Add) button.
    await openComposerTray(page);

    await expect(
      page.locator('.fw-chat-composer__mode').getByRole('radio', { name: 'Accept edits' }),
      'a project with no stored mode of its own showed the other project\'s Plan instead of its own Accept edits default',
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('the selected effort persists across a reload regardless of project', async ({ page }) => {
    await openSandboxProject(page);
    await page.goto('/#/chat');
    await page.waitForLoadState('domcontentloaded');
    // Redesign: the mode and effort controls sit in the tray behind the composer's "+" (Add) button.
    await openComposerTray(page);

    // Two labelled triggers sit in the composer now (Effort and Model): pick the Effort one by its title.
    const effortTrigger = page.locator('.fw-chat-composer__labelled-trigger[title="Effort"]');
    await expect(effortTrigger).toHaveText('Default');
    await effortTrigger.click();
    await page.getByRole('menuitemradio', { name: 'Low' }).click();
    await expect(effortTrigger).toHaveText('Low');

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await openSandboxProject(page);
    await page.goto('/#/chat');
    await page.waitForLoadState('domcontentloaded');
    // Redesign: the mode and effort controls sit in the tray behind the composer's "+" (Add) button.
    await openComposerTray(page);

    await expect(page.locator('.fw-chat-composer__labelled-trigger[title="Effort"]'), 'effort did not survive a real reload').toHaveText(
      'Low',
    );
  });
});
