// scratch probe: on an imported_id match (where the amount need NOT be equal),
// which fields does Actual actually write from the bank's row?
const api = require('/home/vscode/git/actual-budget-transformer/node_modules/@actual-app/api');
const F = ['date','amount','imported_id','imported_payee','notes','category','cleared','payee'];
const pick = t => Object.fromEntries(F.map(k => [k, t[k]]));
(async () => {
  await api.init({ serverURL: 'http://localhost:5006', password: 'test-password',
                   dataDir: '/tmp/probe-fields-data' });
  const b = await api.getBudgets();
  await api.downloadBudget(b.find(x => x.name === 'Test Budget').groupId);
  const acct = (await api.getAccounts()).find(a => a.name === 'Test Savings').id;
  const cats = (await api.getCategories()).filter(c => !c.is_group && c.id);
  const catA = cats[0].id, catB = cats[1].id;

  const cases = [
    { tag: 'existing FULL (payee, notes, category set)',
      seed: { date: '2034-02-10', amount: -5000, imported_id: 'PF-1',
              payee_name: 'Old Payee', notes: 'old notes', category: catA, cleared: false } },
    { tag: 'existing EMPTY (no notes, no category)',
      seed: { date: '2034-03-10', amount: -7000, imported_id: 'PF-2',
              payee_name: 'Old Payee 2', cleared: false } },
  ];
  for (const c of cases) {
    await api.addTransactions(acct, [c.seed]);
  }
  await api.sync();

  const before = {};
  for (const t of await api.getTransactions(acct, '2034-01-01', '2034-12-31')) before[t.imported_id] = pick(t);

  // bank re-sends BOTH with every field different, same imported_id
  const r = await api.importTransactions(acct, [
    { date: '2034-02-14', amount: -5555, imported_id: 'PF-1', payee_name: 'Bank Payee',
      notes: 'bank notes', category: catB, cleared: true },
    { date: '2034-03-14', amount: -7777, imported_id: 'PF-2', payee_name: 'Bank Payee',
      notes: 'bank notes', category: catB, cleared: true },
  ]);
  console.log('import ->', JSON.stringify({ added: r.added.length, updated: r.updated.length }));
  await api.sync();

  const after = {};
  for (const t of await api.getTransactions(acct, '2034-01-01', '2034-12-31')) after[t.imported_id] = pick(t);

  for (const c of cases) {
    const id = c.seed.imported_id;
    console.log('\n### ' + c.tag);
    for (const k of F) {
      const was = JSON.stringify(before[id][k]), now = JSON.stringify(after[id][k]);
      console.log(`  ${k.padEnd(15)} was=${String(was).padEnd(42)} now=${now}  ${was === now ? '' : '<-- WRITTEN'}`);
    }
  }
  await api.shutdown();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
