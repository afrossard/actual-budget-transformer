// isolate: does updateTransaction throw because of `reconciled`, or because of the fields?
const api = require('/home/vscode/git/actual-budget-transformer/node_modules/@actual-app/api');
const seed = async (acct, payee) => {
  await api.addTransactions(acct, [{ date: '2037-01-10', amount: -1000, payee_name: payee, notes: 'seed' }]);
  await api.sync();
  return (await api.getTransactions(acct, '2037-01-01', '2037-12-31')).find(t => t.imported_payee === payee);
};
const attempt = async (label, id, fields) => {
  try { await api.updateTransaction(id, fields); await api.sync(); console.log(`${label} -> OK`); }
  catch (e) { console.log(`${label} -> THREW: ${e.message}`); }
};
(async () => {
  await api.init({ serverURL: 'http://localhost:5006', password: 'test-password', dataDir: '/tmp/probe-patch-data' });
  const b = await api.getBudgets();
  await api.downloadBudget(b.find(x => x.name === 'Test Budget').groupId);
  const acct = (await api.getAccounts()).find(a => a.name === 'Test Credit Card').id;

  const plain = await seed(acct, 'Plain Row');
  await attempt('not reconciled, patch date+amount+notes', plain.id, { date: '2037-01-12', amount: -1111, notes: 'patched' });
  await attempt('not reconciled, patch notes only      ', plain.id, { notes: 'again' });

  const rec = await seed(acct, 'Reconciled Row');
  await api.updateTransaction(rec.id, { reconciled: true }); await api.sync();
  await attempt('reconciled,     patch notes only      ', rec.id, { notes: 'patched' });
  await attempt('reconciled,     patch date+amount     ', rec.id, { date: '2037-01-12', amount: -1111 });

  for (const t of await api.getTransactions(acct, '2037-01-01', '2037-12-31')) {
    console.log(`  final: ${t.imported_payee} ${t.date} ${t.amount} notes=${t.notes} reconciled=${t.reconciled}`);
  }
  await api.shutdown();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
