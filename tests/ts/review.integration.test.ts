/**
 * The review loop and the gateway, against a real Actual server.
 *
 * Nothing here is mocked. The reason these tests exist is that Actual's real
 * behaviour is surprising, and a mock would encode our assumptions rather than
 * check them.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify, tally, type ActualTransaction } from '../../src/classify.ts';
import { createScriptedIo } from '../../src/io.ts';
import { correctionTargets, review } from '../../src/review.ts';
import type { SourceTransaction } from '../../src/sources/types.ts';
import {
  closeSession,
  createRunAccount,
  openSession,
  seedScenario,
  runTag,
  serverReachable,
  skipReason,
  type Scenario,
  type Session,
} from './actual-fixture.ts';

const skip = skipReason(await serverReachable());

describe('integration: the review loop', { skip }, () => {
  let session: Session;

  before(async () => {
    session = await openSession();
  });

  after(async () => {
    await closeSession(session);
  });

  /** A fresh account, seeded, classified once. */
  async function arrange(label: string): Promise<{
    accountId: string;
    accountName: string;
    scenario: Scenario;
    existing: ActualTransaction[];
    boundary: string | null;
  }> {
    const account = await createRunAccount(session, label);
    const scenario = await seedScenario(session, account.id);
    const existing = await session.gateway.getAccountHistory(account.id);
    const boundary = await session.gateway.reconciliationBoundary(account.id);
    return {
      accountId: account.id,
      accountName: account.name,
      scenario,
      existing,
      boundary,
    };
  }

  async function storedByImportedId(
    accountId: string,
  ): Promise<Map<string, ActualTransaction>> {
    const rows = await session.gateway.getTransactions(
      accountId,
      '2030-01-01',
      '2032-12-31',
    );
    return new Map(rows.filter((t) => t.imported_id).map((t) => [t.imported_id!, t]));
  }

  it('derives the reconciliation boundary from the newest reconciled transaction', async () => {
    const { boundary, scenario } = await arrange('boundary');
    assert.equal(boundary, scenario.boundary);
  });

  it('reaches every one of the four buckets on one seeded month', async () => {
    const { scenario, existing, boundary } = await arrange('buckets');
    const rows = classify(scenario.source, existing, boundary);

    assert.deepEqual(tally(rows), {
      locked: 1,
      skip: 2,
      suspicious: 3,
      clean: 8,
    });
    assert.deepEqual(
      rows.map((r) => `${r.source.payee} ${r.bucket}`),
      [
        'SUPERMARKET CORRECTION locked',
        'MIGROS clean',
        'SBB TICKET clean',
        'SALARY ACME SA skip',
        'RESTAURANT DES ALPES suspicious',
        'CAFE LUGANO suspicious',
        'CAFE LUGANO clean',
        'CAFE LUGANO clean',
        'CAFE LUGANO clean',
        'CAFE LUGANO clean',
        'PRICE CHANGED skip',
        'PHARMACIE CENTRALE clean',
        'PHARMACIE CENTRALE suspicious',
        'UBS TWINT clean',
      ],
    );
  });

  it('sees the split hand entry as a split, so a correction can say so', async () => {
    const { scenario, existing, boundary } = await arrange('split-evidence');
    const rows = classify(scenario.source, existing, boundary);
    const restaurant = rows.find((r) => r.source.payee === 'RESTAURANT DES ALPES')!;
    const reason = restaurant.reasons.find(
      (r) => r.kind === 'same-amount-within-one-day',
    );
    assert.ok(reason?.kind === 'same-amount-within-one-day');
    assert.equal(reason.candidates.length, 1);
    assert.equal(reason.candidates[0]!.id, scenario.splitId);
    assert.equal(reason.candidates[0]!.is_parent, true);
  });

  it('writes nothing at all when every row is left', async () => {
    const { accountId, accountName, scenario, existing, boundary } =
      await arrange('leave-all');
    const rows = classify(scenario.source, existing, boundary);
    const io = createScriptedIo(rows.map(() => 'l'));

    const result = await review({
      gateway: session.gateway,
      accountId,
      accountName,
      rows,
      boundary,
      io,
    });

    assert.equal(result.stopped, false);
    assert.equal(
      result.outcomes.every((o) => o.wrote === 'nothing'),
      true,
    );
    const after = await session.gateway.getTransactions(
      accountId,
      '2030-01-01',
      '2032-12-31',
    );
    assert.equal(after.length, existing.length);
  });

  it('leaves the reconciled transaction untouched when the locked row is declined', async () => {
    // The tool's own guard: `updateTransaction` would patch a reconciled
    // transaction without complaint, so the only thing standing between the
    // bank's correction and an attested range is this decline.
    const { accountId, accountName, scenario, existing, boundary } =
      await arrange('locked-declined');
    const rows = classify(scenario.source, existing, boundary);
    const locked = rows[0]!;
    assert.equal(locked.bucket, 'locked');

    const before = existing.find((t) => t.id === scenario.reconciledId)!;
    const io = createScriptedIo(['l']);
    await review({
      gateway: session.gateway,
      accountId,
      accountName,
      rows: [locked],
      boundary,
      io,
    });

    const after = (
      await session.gateway.getTransactions(accountId, '2030-01-01', '2030-12-31')
    ).find((t) => t.id === scenario.reconciledId)!;
    assert.deepEqual(after, before);
    // And the decline was prompted with its evidence, not swallowed by a log line.
    assert.ok(
      io.transcript.some((line) => line.includes('inside the reconciled range')),
      `expected the reconciled-range warning in the transcript, got:\n${io.transcript.join('\n')}`,
    );
  });

  it('patches inside the reconciled range only on a confirmation for that row', async () => {
    // The control for the test above: the guard is the confirmation, not an
    // accident of the write path. Actual itself enforces nothing here, and
    // leaves `reconciled` true afterwards.
    const { accountId, accountName, scenario, existing, boundary } =
      await arrange('locked-confirmed');
    const rows = classify(scenario.source, existing, boundary);
    const locked = rows[0]!;

    const io = createScriptedIo(['c']);
    const result = await review({
      gateway: session.gateway,
      accountId,
      accountName,
      rows: [locked],
      boundary,
      io,
    });

    assert.equal(result.outcomes[0]!.wrote, 'corrected');
    const after = (
      await session.gateway.getTransactions(accountId, '2030-01-01', '2030-12-31')
    ).find((t) => t.id === scenario.reconciledId)!;
    assert.equal(after.imported_id, locked.source.importedId);
    assert.equal(after.notes, locked.source.notes);
    assert.equal(after.reconciled, true, 'Actual keeps the reconciled flag set');
    assert.equal(after.amount, -12000, 'the amount is never written');
  });

  it('correcting a split parent leaves the parts alone and never the amount', async () => {
    const { accountId, accountName, scenario, existing, boundary } =
      await arrange('correct-split');
    const rows = classify(scenario.source, existing, boundary);
    const restaurant = rows.find((r) => r.source.payee === 'RESTAURANT DES ALPES')!;

    const io = createScriptedIo(['c']);
    const result = await review({
      gateway: session.gateway,
      accountId,
      accountName,
      rows: [restaurant],
      boundary,
      io,
    });
    assert.equal(result.outcomes[0]!.wrote, 'corrected');

    const after = (
      await session.gateway.getTransactions(accountId, '2031-03-01', '2031-03-31')
    ).find((t) => t.id === scenario.splitId)!;
    assert.equal(after.amount, -6400);
    assert.deepEqual(
      after.subtransactions?.map((s) => s.amount),
      [-4000, -2400],
      'the parts still sum to their parent',
    );
    assert.equal(after.date, restaurant.source.date, "the bank's date was taken");
    assert.equal(after.imported_id, restaurant.source.importedId);
    assert.ok(io.transcript.some((line) => line.includes('split parts were left')));
  });

  it('refuses to correct when the bank and Actual disagree on the amount', async () => {
    const { accountId, accountName, scenario, existing, boundary } =
      await arrange('amount-mismatch');
    const rows = classify(scenario.source, existing, boundary);
    const changed = rows.find((r) => r.source.payee === 'PRICE CHANGED')!;
    assert.equal(changed.bucket, 'skip');

    const io = createScriptedIo(['c']);
    const result = await review({
      gateway: session.gateway,
      accountId,
      accountName,
      rows: [changed],
      boundary,
      io,
    });

    assert.equal(result.outcomes[0]!.wrote, 'nothing');
    assert.match(
      result.outcomes[0]!.refusal ?? '',
      /bank says -75.00 and Actual holds -80.00/,
    );
    const after = (
      await session.gateway.getTransactions(accountId, '2031-03-01', '2031-03-31')
    ).find((t) => t.id === scenario.amountMismatchId)!;
    assert.equal(after.amount, -8000, 'nothing was applied');
    assert.equal(after.notes, 'stored at -80.00 while the bank now says -75.00');
  });

  it('forces a separate transaction with a reproducible minted ID', async () => {
    const { accountId, accountName, scenario, existing, boundary } =
      await arrange('force');
    const rows = classify(scenario.source, existing, boundary);
    const salary = rows.find((r) => r.source.payee === 'SALARY ACME SA')!;
    assert.equal(salary.bucket, 'skip');

    const io = createScriptedIo(['f']);
    const result = await review({
      gateway: session.gateway,
      accountId,
      accountName,
      rows: [salary],
      boundary,
      io,
    });

    assert.equal(result.outcomes[0]!.wrote, 'forced');
    const stored = await storedByImportedId(accountId);
    const forcedId = `${salary.source.importedId}~dup1`;
    assert.ok(stored.has(forcedId), `expected ${forcedId} in ${[...stored.keys()]}`);
    assert.equal(stored.get(forcedId)!.amount, 650000);
    // The original is still there: forcing adds, it does not replace.
    assert.ok(stored.has(salary.source.importedId));
  });

  it('a second run of the same batch writes nothing', async () => {
    const { accountId, accountName, scenario, existing, boundary } =
      await arrange('idempotent');
    const first = classify(scenario.source, existing, boundary);

    // Import everything importable; leave the rest.
    const firstAnswers = first.map((row) => (row.bucket === 'skip' ? 'l' : 'i'));
    const firstResult = await review({
      gateway: session.gateway,
      accountId,
      accountName,
      rows: first,
      boundary,
      io: createScriptedIo(firstAnswers),
    });
    const added = firstResult.outcomes.filter((o) => o.wrote === 'added');
    assert.equal(added.length, 12);

    const afterFirst = await session.gateway.getTransactions(
      accountId,
      '2030-01-01',
      '2032-12-31',
    );
    const second = classify(scenario.source, afterFirst, boundary);

    // Everything that carried a reference and was written comes back as Skip.
    const withReference = second.filter((r) => r.source.importedId !== '');
    assert.equal(
      withReference.every((r) => r.bucket === 'skip'),
      true,
      withReference.map((r) => `${r.source.payee} ${r.bucket}`).join(', '),
    );
    // The reference-less twins cannot Skip, so they surface as Suspicious
    // against what the first run wrote rather than being written again.
    const twins = second.filter((r) => r.source.importedId === '');
    assert.deepEqual(
      twins.map((r) => r.bucket),
      ['suspicious', 'suspicious'],
    );

    const secondResult = await review({
      gateway: session.gateway,
      accountId,
      accountName,
      rows: second,
      boundary,
      io: createScriptedIo(second.map(() => 'l')),
    });
    assert.equal(
      secondResult.outcomes.every((o) => o.wrote === 'nothing'),
      true,
    );
    const afterSecond = await session.gateway.getTransactions(
      accountId,
      '2030-01-01',
      '2032-12-31',
    );
    assert.equal(afterSecond.length, afterFirst.length);
  });

  it('stops the run on quit and leaves the remaining rows untouched', async () => {
    const { accountId, accountName, scenario, existing, boundary } =
      await arrange('quit');
    const rows = classify(scenario.source, existing, boundary);
    const io = createScriptedIo(['l', 'q']);

    const result = await review({
      gateway: session.gateway,
      accountId,
      accountName,
      rows,
      boundary,
      io,
    });

    assert.equal(result.stopped, true);
    assert.equal(result.outcomes.length, 2);
    assert.equal(result.outcomes[1]!.action, 'quit');
    const after = await session.gateway.getTransactions(
      accountId,
      '2030-01-01',
      '2032-12-31',
    );
    assert.equal(after.length, existing.length);
  });

  it('importing then correcting the same payee does not create a second payee', async () => {
    // `add` passes `payee_name` and Actual resolves or creates the payee
    // server-side, so a payee list cached before that write goes stale. A
    // correction on the same payee later in the run would then fail to find it
    // and create a duplicate, linking the corrected transaction to the twin.
    //
    // The payee has to be one the budget has never seen, or it is already in the
    // cache and the staleness cannot show: payees are budget-global and outlive
    // both the run and the account.
    const account = await createRunAccount(session, 'payee-cache');
    const payee = `CAFE ${runTag()}`;
    const importedId = `${runTag()}-payee-cache`;

    await session.api.addTransactions(account.id, [
      { date: '2031-05-10', amount: -500, payee_name: 'Typed By Hand' },
    ]);
    await session.api.sync();

    // Reading the history is what loads the cache, before either write.
    const existing = await session.gateway.getAccountHistory(account.id);
    const source: SourceTransaction[] = [
      {
        date: '2031-05-01',
        amountCents: -777,
        payee,
        notes: '',
        importedId: `${importedId}-a`,
        importedIdOrigin: 'bank-reference',
        sourceLine: 1,
      },
      {
        date: '2031-05-10',
        amountCents: -500,
        payee,
        notes: '',
        importedId: `${importedId}-b`,
        importedIdOrigin: 'bank-reference',
        sourceLine: 2,
      },
    ];
    const rows = classify(source, existing, null);
    assert.deepEqual(
      rows.map((r) => r.bucket),
      ['clean', 'suspicious'],
    );

    const result = await review({
      gateway: session.gateway,
      accountId: account.id,
      accountName: account.name,
      rows,
      boundary: null,
      io: createScriptedIo(['i', 'c']),
    });
    assert.deepEqual(
      result.outcomes.map((o) => o.wrote),
      ['added', 'corrected'],
    );

    // Actual title-cases the payee names it creates, so compare case-insensitively.
    const named = (await session.api.getPayees()).filter(
      (p) => p.name.toLowerCase() === payee.toLowerCase(),
    );
    assert.equal(named.length, 1, `duplicate payees: ${JSON.stringify(named)}`);

    const corrected = (await session.gateway.getAccountHistory(account.id)).find(
      (t) => t.imported_id === `${importedId}-b`,
    )!;
    assert.equal(corrected.payee, named[0]!.id, 'linked to the one payee, not a twin');
  });

  it('a correction keeps the payee and notes the bank left blank', async () => {
    // A blank description column parses as payee '' and notes ''. Sending those
    // would wipe the human's own data and create a payee named '' in the budget.
    const account = await createRunAccount(session, 'blank-correct');
    await session.api.addTransactions(account.id, [
      {
        date: '2031-06-10',
        amount: -4500,
        payee_name: 'Dentist',
        notes: 'quarterly checkup',
      },
    ]);
    await session.api.sync();
    const existing = await session.gateway.getAccountHistory(account.id);
    const before = existing[0]!;
    // Payees are budget-global and outlive the run, so compare against what was
    // there before rather than expecting none.
    const blankPayees = async (): Promise<number> =>
      (await session.api.getPayees()).filter((p) => p.name === '').length;
    const blankBefore = await blankPayees();

    const importedId = `${runTag()}-blank-correct`;
    const rows = classify(
      [
        {
          date: '2031-06-11',
          amountCents: -4500,
          payee: '',
          notes: '',
          importedId,
          importedIdOrigin: 'bank-reference',
          sourceLine: 1,
        },
      ],
      existing,
      null,
    );
    assert.equal(rows[0]!.bucket, 'suspicious');

    const io = createScriptedIo(['c']);
    const result = await review({
      gateway: session.gateway,
      accountId: account.id,
      accountName: account.name,
      rows,
      boundary: null,
      io,
    });
    assert.equal(result.outcomes[0]!.wrote, 'corrected');

    const after = (await session.gateway.getAccountHistory(account.id))[0]!;
    assert.equal(after.imported_id, importedId);
    assert.equal(after.date, '2031-06-11', "the bank's date was taken");
    assert.equal(after.payee, before.payee);
    assert.equal(after.notes, 'quarterly checkup');
    assert.equal(await blankPayees(), blankBefore, 'no payee named "" was created');
    // The run says only what it wrote.
    assert.ok(
      io.transcript.some((line) => line.endsWith('corrected date, imported ID')),
      io.transcript.join('\n'),
    );
  });

  it('two rows cannot correct the same stored transaction in one run', async () => {
    // Both rows are within a day of the one hand entry. If the second could
    // correct it too, it would overwrite the first row's imported ID, and the
    // first row would come back Clean next run and be written as a duplicate.
    const account = await createRunAccount(session, 'correct-twice');
    await session.api.addTransactions(account.id, [
      { date: '2031-03-10', amount: -450, payee_name: 'Coffee (typed by hand)' },
    ]);
    await session.api.sync();
    const existing = await session.gateway.getAccountHistory(account.id);
    const stored = existing[0]!;

    const tag = `${runTag()}-correct-twice`;
    const source: SourceTransaction[] = ['2031-03-10', '2031-03-11'].map((date, i) => ({
      date,
      amountCents: -450,
      payee: 'CAFE LUGANO',
      notes: 'Carte',
      importedId: `${tag}-${i + 1}`,
      importedIdOrigin: 'bank-reference',
      sourceLine: i + 1,
    }));
    const rows = classify(source, existing, null);
    assert.deepEqual(
      rows.map((r) => correctionTargets(r).map((t) => t.id)),
      [[stored.id], [stored.id]],
      'both rows start out pointing at the one hand entry',
    );

    // `c` on the second row would be refused by the scripted io, so the only
    // thing the script can answer there is what is still offered.
    const io = createScriptedIo(['c', 'l']);
    const result = await review({
      gateway: session.gateway,
      accountId: account.id,
      accountName: account.name,
      rows,
      boundary: null,
      io,
    });
    assert.deepEqual(
      result.outcomes.map((o) => o.wrote),
      ['corrected', 'nothing'],
    );
    const secondPrompt = io.transcript.filter((line) => line.includes('[?] detail'))[1];
    assert.ok(secondPrompt !== undefined && !secondPrompt.includes('[c]orrect'));
    assert.ok(
      io.transcript.some((line) =>
        line.includes('already corrected by an earlier row in this run'),
      ),
      io.transcript.join('\n'),
    );

    const after = await session.gateway.getAccountHistory(account.id);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.imported_id, `${tag}-1`, "the first row's ID was kept");
  });

  it('cancelling the which-one prompt writes nothing', async () => {
    const { accountId, accountName, scenario, boundary } =
      await arrange('cancel-choice');
    // Two equal-amount neighbours within a day of one source row.
    await session.api.addTransactions(accountId, [
      { date: '2031-03-19', amount: -1990, payee_name: 'Pharmacy A' },
      { date: '2031-03-21', amount: -1990, payee_name: 'Pharmacy B' },
    ]);
    await session.api.sync();
    const history = await session.gateway.getAccountHistory(accountId);
    const rows = classify(scenario.source, history, boundary);
    const twin = rows.find((r) => r.source.payee === 'PHARMACIE CENTRALE')!;
    assert.ok(correctionTargets(twin).length > 1);

    const io = createScriptedIo(['c', 'q']);
    const result = await review({
      gateway: session.gateway,
      accountId,
      accountName,
      rows: [twin],
      boundary,
      io,
    });

    assert.equal(result.outcomes[0]!.wrote, 'nothing');
    assert.equal(result.stopped, false, 'cancelling the choice does not stop the run');
    assert.ok(io.transcript.some((line) => line.includes('cancelled')));
    const after = await session.gateway.getAccountHistory(accountId);
    assert.equal(after.length, history.length);
  });

  it('shows the detail on request without writing anything', async () => {
    const { accountId, accountName, scenario, existing, boundary } =
      await arrange('detail');
    const rows = classify(scenario.source, existing, boundary);
    const restaurant = rows.find((r) => r.source.payee === 'RESTAURANT DES ALPES')!;
    const io = createScriptedIo(['?', 'l']);

    const result = await review({
      gateway: session.gateway,
      accountId,
      accountName,
      rows: [restaurant],
      boundary,
      io,
    });

    assert.equal(result.outcomes[0]!.wrote, 'nothing');
    assert.ok(io.transcript.some((line) => /line \d+ of the file/.test(line)));
    // Actual title-cases payee names it creates, so match case-insensitively.
    const transcript = io.transcript.join('\n').toLowerCase();
    assert.ok(transcript.includes('restaurant (typed by hand)'), transcript);
  });
});
