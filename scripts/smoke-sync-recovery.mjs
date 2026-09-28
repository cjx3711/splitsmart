/** Bootstrap failure/retry and bulk-entry navigation against a seeded dev server.
 * node scripts/smoke-sync-recovery.mjs [base-url] [screenshot-directory]
 * No expenses or groups are created.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const base = process.argv[2] ?? 'http://localhost:5644';
const output = process.argv[3] ?? '/tmp/splitsmart-sync-recovery';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  // Verify navigation using an isolated browser and the seeded account.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(`${base}/app/login`);
  await page.getByLabel('Email', { exact: true }).fill('test@example.com');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  await page.getByLabel('CSV file', { exact: true }).waitFor({ timeout: 20000 });
  console.log('PASS: Bulk add loads with a completed sync.');
  const groups = await page.evaluate(async () => (await (await fetch('/api/v1/groups')).json()).groups);
  assert.ok(groups.length);
  const group = groups[0];
  await page.goto(`${base}/app/groups/${group.id}`);
  await page.getByRole('button', { name: 'Bulk add', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Expense', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New expense' });
  await dialog.getByRole('button', { name: 'Bulk add', exact: true }).waitFor();
  await page.screenshot({ path: `${output}/expense-dialog.png`, fullPage: true, animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Bulk add', exact: true }).click();
  await page.getByLabel('CSV file', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Group', { exact: true }).inputValue(), group.id);
  assert.equal(await page.getByRole('dialog').count(), 0);
  console.log('PASS: group page and Expense dialog expose Bulk add; dialog closes and carries the group.');
  assert.deepEqual(errors, []);
  await context.close();

  // A first bootstrap failure must have a visible error and a working retry.
  const failed = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  let blockBootstrap = true;
  await failed.route('**/api/v1/sync/bootstrap*', async route => {
    if (blockBootstrap) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated schema mismatch' }) });
    else await route.continue();
  });
  const failurePage = await failed.newPage();
  await failurePage.goto(`${base}/app/login`);
  await failurePage.getByLabel('Email', { exact: true }).fill('test@example.com');
  await failurePage.getByLabel('Password', { exact: true }).fill('password123');
  await failurePage.getByRole('button', { name: 'Log in', exact: true }).click();
  await failurePage.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await failurePage.getByRole('button', { name: 'Bulk add', exact: true }).click();
  await failurePage.getByRole('heading', { name: 'Could not load your data' }).waitFor();
  await failurePage.getByRole('button', { name: /Sync failed/ }).waitFor();
  await failurePage.screenshot({ path: `${output}/failure-mobile.png`, fullPage: true, animations: 'disabled' });
  blockBootstrap = false;
  await failurePage.getByRole('button', { name: 'Try again', exact: true }).click();
  await failurePage.getByLabel('CSV file', { exact: true }).waitFor({ timeout: 20000 });
  await failurePage.getByRole('button', { name: /^Synced/ }).waitFor();
  assert.equal(await failurePage.getByRole('heading', { name: 'Could not load your data' }).count(), 0);
  console.log('PASS: failed bootstrap displays Sync failed plus Try again; retry loads Bulk add and returns to Synced.');
} finally { await browser.close(); }
