// scratch probe: what happens to category splits when the bank re-sends a
// transaction under the same imported_id with a different amount?
const api = require('/home/vscode/git/actual-budget-transformer/node_modules/@actual-app/api');
const show = async (acct, label) => {
  const rows = await api.getTransactions(acct, '2033-01-01', '2033-12-31');
  console.log('--- ' + label);
  for (const r of rows) {
    console.log(`  ${r.date} ${r.amount} parent=${!!r.is_parent} id=${r.imported_id} ` +
      `payee=${r.imported_payee} subs=${(r.subtransactions || []).map(s => s.amount).join('/') || 'none'}`);
  }
};
(async () => {
  await api.init({ serverURL: 'http://localhost:5006', password: 'test-password',
                   dataDir: '/tmp/probe-split-data' });
  const budgets = await api.getBudgets();
  await api.downloadBudget(budgets.find(b => b.name === 'Test Budget').groupId);
  const acct = (await api.getAccounts()).find(a => a.name === 'Test Savings').id;
  const cats = await api.getCategories();
  const c1 = cats[0].id, c2 = cats[1].id;

  // a transaction the tool imported, which the human then split in Actual
  await api.addTransactions(acct, [{
    date: '2033-04-10', amount: -10000, imported_id: 'PROBE-SPLIT-1',
    payee_name: 'Supermarket', notes: 'imported earlier',
    subtransactions: [
      { amount: -6000, category: c1, notes: 'groceries' },
      { amount: -4000, category: c2, notes: 'household' },
    ],
  }]);
  await api.sync();
  await show(acct, 'after the human split it');

  // the bank re-sends the same transaction, same imported_id, corrected amount
  const r = await api.importTransactions(acct, [{
    date: '2033-04-10', amount: -11000, imported_id: 'PROBE-SPLIT-1',
    payee_name: 'Supermarket SA',
  }]);
  console.log('importTransactions ->', JSON.stringify({ added: r.added.length, updated: r.updated.length }));
  await api.sync();
  await show(acct, 'after the bank re-sent it with -110.00');

  // and what a plain field patch does to the splits
  const parent = (await api.getTransactions(acct, '2033-01-01', '2033-12-31'))
    .find(t => t.imported_id === 'PROBE-SPLIT-1');
  await api.updateTransaction(parent.id, { date: '2033-04-12', notes: 'patched' });
  await api.sync();
  await show(acct, 'after updateTransaction on date+notes only');
  await api.shutdown();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
