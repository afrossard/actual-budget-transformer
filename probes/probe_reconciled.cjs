// scratch probe: can a RECONCILED transaction be changed, and by which call?
const api = require('/home/vscode/git/actual-budget-transformer/node_modules/@actual-app/api');
const F = ['date','amount','imported_id','imported_payee','notes','reconciled','cleared'];
const pick = t => Object.fromEntries(F.map(k => [k, t[k]]));
const find = async (acct, id) =>
  (await api.getTransactions(acct, '2036-01-01', '2036-12-31')).find(t => t.imported_id === id || t.id === id);
(async () => {
  await api.init({ serverURL: 'http://localhost:5006', password: 'test-password',
                   dataDir: '/tmp/probe-rec-data' });
  const b = await api.getBudgets();
  await api.downloadBudget(b.find(x => x.name === 'Test Budget').groupId);
  const acct = (await api.getAccounts()).find(a => a.name === 'Test Savings').id;

  // a pending-style row: no imported_id, as if captured by hand
  await api.addTransactions(acct, [
    { date: '2036-07-10', amount: -2162, payee_name: 'Pending Intl Card', notes: 'pending' },
  ]);
  await api.sync();
  let row = (await api.getTransactions(acct, '2036-01-01', '2036-12-31'))
    .find(t => t.imported_payee === 'Pending Intl Card');
  await api.updateTransaction(row.id, { reconciled: true });
  await api.sync();
  row = await find(acct, row.id);
  console.log('seeded + reconciled:', JSON.stringify(pick(row)));

  // (1) can importTransactions touch it? booked version: new date AND amount
  const imp = await api.importTransactions(acct, [
    { date: '2036-07-12', amount: -2210, imported_id: 'BOOKED-1', payee_name: 'Intl Card Booked' },
  ]);
  await api.sync();
  console.log('importTransactions ->', JSON.stringify({ added: imp.added.length, updated: imp.updated.length }));
  const all1 = await api.getTransactions(acct, '2036-01-01', '2036-12-31');
  console.log('rows now:', all1.length, all1.map(t => `${t.date}/${t.amount}/${t.imported_id}`).join('  '));

  // (2) can updateTransaction patch a reconciled row directly?
  try {
    const res = await api.updateTransaction(row.id, { date: '2036-07-12', amount: -2210, notes: 'booked' });
    await api.sync();
    console.log('updateTransaction on reconciled -> OK', Array.isArray(res) ? '' : JSON.stringify(res).slice(0, 120));
  } catch (e) {
    console.log('updateTransaction on reconciled -> REFUSED:', e.message);
  }
  console.log('after patch:', JSON.stringify(pick(await find(acct, row.id))));
  await api.shutdown();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
