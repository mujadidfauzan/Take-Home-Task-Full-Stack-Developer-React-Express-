import { test, expect } from '@playwright/test';

test('create, advance with actors, inspect history, delete, and inspect retained history', async ({ page }, testInfo) => {
  const title = `Prepare Invoice ${testInfo.project.name}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await page.getByLabel('Judul', { exact: true }).fill(title);
  await page.getByLabel('Deskripsi').fill('Invoice for October');
  await page.getByRole('button', { name: 'Tambah task' }).click();
  const task = page.getByRole('article', { name: title, exact: true });
  await expect(task.getByRole('heading', { name: title })).toBeVisible();
  await task.getByRole('button', { name: 'Lihat riwayat' }).click();
  await expect(task.getByText('Belum ada perubahan status.')).toBeVisible();
  await page.getByLabel('Actor', { exact: true }).selectOption('john.doe');
  await task.getByRole('button', { name: 'Pending', exact: true }).click();
  await expect(task.locator('.audit-list li')).toHaveCount(1);
  await page.getByLabel('Actor', { exact: true }).selectOption('jane.smith');
  await task.getByRole('button', { name: 'In progress', exact: true }).click();
  await expect(task.locator('.audit-list li')).toHaveCount(2);
  await task.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(task.locator('.audit-list li')).toHaveCount(3);
  await expect(task.getByText('Selesai', { exact: true })).toBeVisible();
  await expect(task.locator('.audit-list li').first()).toContainText('john.doe');
  await expect(task.locator('.audit-list li').nth(1)).toContainText('jane.smith');
  await page.reload();
  await task.getByRole('button', { name: 'Lihat riwayat' }).click();
  await expect(task.locator('.audit-list li')).toHaveCount(3);
  await expect(page.locator('body')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('task-history.png'), fullPage: true });
  await task.getByRole('button', { name: `Hapus ${title}`, exact: true }).click();
  await task.getByRole('button', { name: 'Hapus', exact: true }).click();
  await expect(task).toHaveCount(0);
  await page.getByRole('tab', { name: 'Terhapus' }).click();
  const archived = page.getByRole('article', { name: title, exact: true });
  await expect(archived).toBeVisible();
  await archived.getByRole('button', { name: 'Lihat riwayat' }).click();
  await expect(archived.locator('.audit-list li')).toHaveCount(3);
  await expect(archived.getByRole('button', { name: `Hapus ${title}`, exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('long titles and descriptions fit on the viewport', async ({ page }, testInfo) => {
  await page.goto('/');
  const title = `${testInfo.project.name}-` + 'x'.repeat(95);
  await page.getByLabel('Judul', { exact: true }).fill(title);
  await page.getByLabel('Deskripsi').fill('a'.repeat(600));
  await page.getByRole('button', { name: 'Tambah task' }).click();
  const task = page.getByRole('article', { name: title, exact: true });
  await expect(task).toBeVisible();
  await task.getByRole('button', { name: `Hapus ${title}`, exact: true }).click();
  await expect(task.getByText(`Hapus task "${title}"?`, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('long-content.png'), fullPage: true });
  await task.getByRole('button', { name: 'Hapus', exact: true }).click();
  await expect(task).toHaveCount(0);
});

test('shows a loading error and recovers after retry without losing form input', async ({ page }) => {
  const endpoint = '**/api/tasks?deleted=false';
  await page.route(endpoint, (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Database temporarily unavailable.' } })
  }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Database temporarily unavailable.');
  await page.getByLabel('Judul', { exact: true }).fill('Retry task');
  await expect(page.getByRole('button', { name: 'Tambah task' })).toBeDisabled();
  await page.unroute(endpoint);
  await page.getByRole('button', { name: 'Muat ulang task' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tambah task' })).toBeEnabled();
  await expect(page.getByLabel('Judul', { exact: true })).toHaveValue('Retry task');
});

test('two browser clients receive create, status, audit, and deletion changes in realtime', async ({ page, context }, testInfo) => {
  const second = await context.newPage();
  const title = `Realtime task ${testInfo.project.name}`;
  await page.goto('/');
  await second.goto('/');
  await expect(page.getByText('Terhubung', { exact: true })).toBeVisible();
  await expect(second.getByText('Terhubung', { exact: true })).toBeVisible();
  await page.getByLabel('Judul', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Tambah task' }).click();
  const local = page.getByRole('article', { name: title, exact: true });
  const remote = second.getByRole('article', { name: title, exact: true });
  await expect(remote).toBeVisible({ timeout: 5000 });
  await remote.getByRole('button', { name: 'Lihat riwayat' }).click();
  await expect(remote.getByText('Belum ada perubahan status.')).toBeVisible();
  await page.getByLabel('Actor', { exact: true }).selectOption('alex.chen');
  await local.getByRole('button', { name: 'Pending', exact: true }).click();
  await expect(remote.getByRole('button', { name: 'In progress', exact: true })).toBeVisible({ timeout: 5000 });
  await expect(remote.locator('.audit-list li')).toHaveCount(1);
  await expect(remote.locator('.audit-list li')).toContainText('alex.chen');
  await local.getByRole('button', { name: `Hapus ${title}`, exact: true }).click();
  await local.getByRole('button', { name: 'Hapus', exact: true }).click();
  await expect(remote).toHaveCount(0, { timeout: 5000 });
  await second.getByRole('tab', { name: 'Terhapus' }).click();
  await expect(remote).toBeVisible();
  await remote.getByRole('button', { name: 'Lihat riwayat' }).click();
  await expect(remote.locator('.audit-list li')).toHaveCount(1);
  await second.close();
});
