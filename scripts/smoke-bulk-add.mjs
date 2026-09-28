/** CSV import browser regression. Run against the isolated smoke server, never production.
 * node scripts/smoke-bulk-add.mjs [base-url] [screenshot-directory]
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const base = process.argv[2] ?? 'http://localhost:5644';
const output = process.argv[3] ?? '/tmp/splitsmart-bulk-add-smoke';
await mkdir(output, { recursive: true });
const prefix = `Bulk CSV ${Date.now()}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, colorScheme: 'dark', reducedMotion: 'reduce' });
try {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/app`);
  await page.getByLabel('Email').fill('test@example.com');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page.getByRole('button', { name: 'Bulk add', exact: true }).click();
  await page.getByLabel('CSV file', { exact: true }).waitFor();
  await page.getByText('LLM prompt', { exact: true }).click();
  assert.match(await page.getByLabel('Prompt to copy').inputValue(), /My expense data:/);
  await page.screenshot({ path: join(output, 'upload-desktop.png'), fullPage: true, animations: 'disabled' });
  const csv = `date,description,amount,currency,paid_by,split_with,category,notes\n2026-09-24,"${prefix} dinner, friends",10.01,USD,me,me;JJ,Dining out,"A note, with comma"\n2026-02-30,${prefix} taxi,12.50,JPY,Wrong Person,me,Unknown category,Correct me\n2026-09-24,Remove this row,1,USD,me,me,,\n`;
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name: 'expenses.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Review expenses', exact: true }).click();
  await page.getByRole('table').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add 3 expenses' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Remove record 4' }).click();
  await page.getByLabel('Date, record 3', { exact: true }).fill('2026-09-24');
  await page.getByLabel('Currency, record 3', { exact: true }).selectOption('USD');
  await page.getByLabel('Category, record 3', { exact: true }).selectOption('');
  const payer = page.getByLabel('Paid by, record 3', { exact: true });
  const jj = await payer.locator('option').evaluateAll(options => options.find(o => o.textContent.includes('JJ'))?.value);
  assert.ok(jj, 'JJ found');
  await payer.selectOption(jj);
  const add = page.getByRole('button', { name: 'Add 2 expenses' });
  assert.equal(await add.isEnabled(), true);
  await page.locator('.bulk-table-scroll').evaluate(el => el.scrollLeft = 0);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: join(output, 'review-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no mobile page overflow');
  await page.screenshot({ path: join(output, 'review-mobile.png'), fullPage: true, animations: 'disabled' });
  await context.setOffline(true);
  await add.click();
  await page.getByRole('heading', { name: '2 expenses added', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add 2 expenses' }).count(), 0);
  await page.getByRole('link', { name: 'View all expenses' }).click();
  await page.getByText(`${prefix} dinner, friends`, { exact: true }).waitFor();
  await page.getByText(`${prefix} taxi`, { exact: true }).waitFor();
  await context.setOffline(false);
  await page.reload();
  await page.getByText(`${prefix} taxi`, { exact: true }).waitFor();
  await page.waitForFunction(async (query) => {
   const response = await fetch(`/api/v1/expenses?q=${encodeURIComponent(query)}`);
   const body = await response.json();
   return body.expenses?.length === 2;
  }, prefix, { timeout: 20000 });
  console.log('PASS: prompt, CSV file, quoted commas, invalid rows, payer/currency/date/category correction, row removal, mobile overflow, offline save and online sync.');
  assert.deepEqual(errors, []);
  const result = await page.evaluate(async () => {
    const { openLocalDb } = await import('/src/db/local.ts');
    const { SyncEngine } = await import('/src/sync/engine.ts');
    const db = openLocalDb('bulk-atomic-test');
    const engine = new SyncEngine(db, 'me');
    engine.sync = async () => {};
    const payload = { description: 'Atomic batch', costMinor: 101, currencyCode: 'USD', date: '2026-09-24', splitType: 'shares', participants: [{ userId: 'me', paidMinor: 101, input: 1 }, { userId: 'friend', paidMinor: 0, input: 1 }] };
    try {
      let failed = false;
      try {
        await engine.enqueueExpenses([
          { kind: 'expense.create', id: 'first', payload },
          { kind: 'expense.create', id: 'invalid', payload: { ...payload, participants: [{ userId: 'me', paidMinor: 1, input: 1 }] } },
        ]);
      } catch { failed = true; }
      const rolledBack = (await db.expenses.count()) === 0 && (await db.outbox.count()) === 0;
      await engine.enqueueExpenses([{ kind: 'expense.create', id: 'first', payload }, { kind: 'expense.create', id: 'second', payload }]);
      const saved = (await db.expenses.count()) === 2 && (await db.outbox.count()) === 2;
      let duplicateRejected = false;
      try { await engine.enqueueExpenses([{ kind: 'expense.create', id: 'third', payload }, { kind: 'expense.create', id: 'first', payload }]); }
      catch { duplicateRejected = true; }
      return { failed, rolledBack, saved, duplicateRejected, finalExpenses: await db.expenses.count(), finalOps: await db.outbox.count() };
    } finally { await db.delete(); }
  });
  assert.deepEqual(result, { failed: true, rolledBack: true, saved: true, duplicateRejected: true, finalExpenses: 2, finalOps: 2 });
  console.log('PASS: a bad row rolls back the entire ledger/outbox batch; valid rows save together; duplicate IDs cannot create a partial retry.');

} finally { await browser.close(); }
