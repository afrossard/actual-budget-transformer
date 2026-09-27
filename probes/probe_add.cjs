// scratch probe: does addTransactions bypass Actual's matcher?
const api = require('/home/vscode/git/actual-budget-transformer/node_modules/@actual-app/api');
(async () => {
  await api.init({ serverURL: 'http://localhost:5006', password: 'test-password',
                   dataDir: '/tmp/probe-add-data' });
  const budgets = await api.getBudgets();
  await api.downloadBudget(budgets.find(b => b.name === 'Test Budget').groupId);
  const acct = (await api.getAccounts()).find(a => a.name === 'Test Savings');

  // hand-entered row, no imported_id
  await api.addTransactions(acct.id, [
    { date: '2032-05-10', amount: -2500, payee_name: 'Typed By Hand', notes: 'manual' },
  ]);
  await api.sync();

  // 1) importTransactions with a unique imported_id, 1 day later, same amount
  const imp = await api.importTransactions(acct.id, [
    { date: '2032-05-11', amount: -2500, imported_id: 'PROBE-IMP-1', payee_name: 'Bank Copy' },
  ]);
  console.log('importTransactions ->', JSON.stringify({ added: imp.added.length, updated: imp.updated.length }));

  // 2) addTransactions with a unique imported_id, same shape
  const add = await api.addTransactions(acct.id, [
    { date: '2032-05-12', amount: -2500, imported_id: 'PROBE-ADD-1', payee_name: 'Bank Copy' },
  ]);
  console.log('addTransactions ->', JSON.stringify(add));
  await api.sync();

  const rows = await api.getTransactions(acct.id, '2032-05-01', '2032-05-31');
  console.log('rows now:', rows.length);
  for (const r of rows) console.log(' ', r.date, r.amount, r.imported_payee, 'imported_id=' + r.imported_id);
  await api.shutdown();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
