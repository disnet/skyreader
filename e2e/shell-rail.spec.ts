import { test, expect } from './fixtures';

/**
 * The framed shell's navigation rail is drag-resizable. Its width is one
 * variable (--sidebar-width, set on the document from the sidebar store), which
 * is what keeps the rail, the toolbar strip's first segment and the content
 * card's left edge moving together — so these assert the *frame*, not just the
 * rail, and the persistence that makes the setting worth having.
 */
test.describe('resizable rail', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const RAIL_MIN = 220;
  const RAIL_MAX = 480;
  const RAIL_DEFAULT = 320;

  const metrics = (page: import('@playwright/test').Page) =>
    page.evaluate(() => ({
      rail: document.querySelector('.sidebar')!.getBoundingClientRect().width,
      cardLeft: document.querySelector('.shell-card')!.getBoundingClientRect().left,
      toolbarLeft: document.getElementById('shell-toolbar')!.getBoundingClientRect().left,
    }));

  /** Drag the handle by dx, and settle the rail's width transition. */
  async function dragBy(page: import('@playwright/test').Page, dx: number) {
    const handle = page.getByRole('separator', { name: 'Resize sidebar' });
    const box = (await handle.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.classList.contains('is-rail-resizing'))
      )
      .toBe(false);
  }

  test('dragging the handle moves the rail and the card with it', async ({ authedPage: page }) => {
    await page.goto('/feeds');
    await expect(page.locator('#app-scroll')).toBeVisible();

    const before = await metrics(page);
    expect(before.rail).toBe(RAIL_DEFAULT);
    // The toolbar's control bar starts where the card does — that's the whole
    // point of the frame's shared columns, and it has to survive a resize.
    expect(before.toolbarLeft).toBe(before.cardLeft);

    await dragBy(page, 100);

    const after = await metrics(page);
    expect(after.rail).toBe(RAIL_DEFAULT + 100);
    expect(after.cardLeft).toBe(before.cardLeft + 100);
    expect(after.toolbarLeft).toBe(after.cardLeft);
  });

  test('the width survives a reload', async ({ authedPage: page }) => {
    await page.goto('/feeds');
    await expect(page.locator('#app-scroll')).toBeVisible();

    await dragBy(page, 60);
    expect((await metrics(page)).rail).toBe(RAIL_DEFAULT + 60);

    await page.reload();
    await expect(page.locator('#app-scroll')).toBeVisible();
    expect((await metrics(page)).rail).toBe(RAIL_DEFAULT + 60);
  });

  test('the rail cannot be dragged past its bounds', async ({ authedPage: page }) => {
    await page.goto('/feeds');
    await expect(page.locator('#app-scroll')).toBeVisible();

    await dragBy(page, -1000);
    expect((await metrics(page)).rail).toBe(RAIL_MIN);

    await dragBy(page, 2000);
    expect((await metrics(page)).rail).toBe(RAIL_MAX);
  });

  test('the handle is a keyboard splitter, and resets on double-click', async ({
    authedPage: page,
  }) => {
    await page.goto('/feeds');
    await expect(page.locator('#app-scroll')).toBeVisible();

    const handle = page.getByRole('separator', { name: 'Resize sidebar' });
    await handle.focus();

    // aria-valuenow is the state itself, so it reads true mid-transition.
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', String(RAIL_DEFAULT + 16));
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(RAIL_DEFAULT - 32));
    await page.keyboard.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', String(RAIL_MAX));
    await page.keyboard.press('Home');
    await expect(handle).toHaveAttribute('aria-valuenow', String(RAIL_MIN));

    await handle.dblclick();
    await expect(handle).toHaveAttribute('aria-valuenow', String(RAIL_DEFAULT));
    await expect.poll(() => metrics(page).then((m) => m.rail)).toBe(RAIL_DEFAULT);
  });

  test('there is no handle below the shell breakpoint', async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/feeds');
    await expect(page.getByRole('separator', { name: 'Resize sidebar' })).toBeHidden();
  });
});
