/**
 * Writing what is not in Actual, and correcting what Actual holds at another
 * amount, unattended and under review, against a real Actual server.
 *
 * Nothing here is mocked. The reason these tests exist is that Actual's real
 * behaviour is surprising, and a mock would encode our assumptions rather than
 * check them.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ActualGateway, type AccountId } from '../../src/actual-gateway.ts';
import { classify, tally, type ActualTransaction } from '../../src/classify.ts';
import { createScriptedIo } from '../../src/io.ts';
import { complete, importStatement } from '../../src/review.ts';
import {
  closeSession,
  createRunAccount,
  openSession,
  seedScenario,
  serverReachable,
  skipReason,
  testSettings,
  type Scenario,
  type Session,
} from './actual-fixture.ts';
import { isoDate } from './iso-date-fixture.ts';
import type { SourceTransaction } from '../../src/sources/types.ts';
import type { IsoDate } from '../../src/iso-date.ts';

const skip = skipReason(await serverReachable());

/** The seeded statement's period; what Actual holds outside its pairs is not listed here. */
const PERIOD = { from: isoDate('2030-06-01'), to: isoDate('2031-03-31') };

/** The seeded statement's unpaired transactions, in the order they are reviewed. */
const TO_REVIEW = [
  '#2 KIOSK',
  '#3 MIGROS',
  '#4 SBB TICKET',
  '#8 CAFE LUGANO',
  '#9 CAFE LUGANO',
  '#10 CAFE LUGANO',
  '#11 CAFE LUGANO',
  '#12 CAFE LUGANO',
  '#14 PHARMACIE CENTRALE',
  '#15 PHARMACIE CENTRALE',
  '#16 UBS TWINT',
];

describe('integration: writing what is not in Actual', { skip }, () => {
  let session: Session;

  before(async () => {
    session = await openSession();
  });

  after(async () => {
    await closeSession(session);
  });

  /** A fresh account, seeded, read the way a run reads it. */
  async function arrange(label: string): Promise<{
    accountId: AccountId;
    scenario: Scenario;
    existing: ActualTransaction[];
    reconciledThrough: IsoDate | null;
  }> {
    const account = await createRunAccount(session, label);
    const scenario = await seedScenario(session, account.id);
    const existing = await session.gateway.getAccountHistory(account.id);
    const reconciledThrough = await session.gateway.reconciledThroughDate(account.id);
    return {
      accountId: account.id,
      scenario,
      existing,
      reconciledThrough,
    };
  }

  it('derives the reconciled-through date from the newest reconciled transaction', async () => {
    const { reconciledThrough, scenario } = await arrange('reconciled-through');
    assert.equal(reconciledThrough, scenario.reconciledThrough);
  });

  it('pairs what Actual holds and sends the rest to review, whatever its date', async () => {
    const { scenario, existing, reconciledThrough } = await arrange('pairs');
    const classified = classify(scenario.source, existing, reconciledThrough);

    assert.deepEqual(tally(classified), { paired: 5, toReview: 11 });
    assert.deepEqual(
      classified
        .filter((c) => c.pair === null)
        .map((c) => `#${c.number} ${c.source.payee}`),
      TO_REVIEW,
    );
    const pairOf = (payee: string, date?: string) =>
      classified.find(
        (c) =>
          c.source.payee === payee && (date === undefined || c.source.date === date),
      )!.pair;
    assert.equal(pairOf('SUPERMARKET CORRECTION')?.actual.id, scenario.reconciledId);
    assert.equal(pairOf('RESTAURANT DES ALPES')?.actual.id, scenario.splitId);
    assert.equal(pairOf('RESTAURANT DES ALPES')?.actual.is_parent, true);
    assert.equal(pairOf('PRICE CHANGED')?.actual.id, scenario.amountMismatchId);
    assert.equal(pairOf('SALARY ACME SA')?.by, 'imported-id');
    assert.equal(pairOf('CAFE LUGANO', '2031-03-09')?.by, 'amount-and-date');
  });

  it('writes nothing at all when every one is left', async () => {
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('leave-all');
    const classified = classify(scenario.source, existing, reconciledThrough);
    // The correction of #13 PRICE CHANGED is asked about first.
    const io = createScriptedIo(['l', ...TO_REVIEW.map(() => 'l')]);

    const result = await importStatement({
      mode: 'review',
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified,
      reconciledThrough,
      io,
    });

    assert.equal(result.stopped, false);
    assert.equal(
      result.outcomes.length,
      TO_REVIEW.length + 1,
      'only the unpaired and the correction are asked',
    );
    assert.equal(
      result.outcomes.every((o) => o.wrote === 'nothing'),
      true,
    );
    assert.deepEqual(await session.gateway.getAccountHistory(accountId), existing);
    assert.equal(
      io.transcript.at(-1),
      '0 imported, 11 left, 1 to fix in Actual, 4 already in Actual.',
    );
    assert.equal(complete(result), false, 'a correction left is not in Actual');
  });

  /**
   * The seeded statement plus one dated the day before the reconciled-through
   * date and missing from Actual, as if deleted there to be imported again.
   */
  function withOneBeforeReconciled(scenario: Scenario): SourceTransaction[] {
    const kiosk = scenario.source[1]!;
    return [
      ...scenario.source,
      {
        ...kiosk,
        date: isoDate('2030-06-29'),
        payee: 'NEWSAGENT',
        amountCents: -520,
        importedId: `${scenario.tag}-T-9003`,
        sourceLine: kiosk.sourceLine + scenario.source.length,
      },
    ];
  }

  it('unattended, writes everything unpaired except what is dated before the reconciled-through date', async () => {
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('unattended');
    const source = withOneBeforeReconciled(scenario);
    const classified = classify(source, existing, reconciledThrough);
    const io = createScriptedIo([]);

    const result = await importStatement({
      mode: 'unattended',
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified,
      reconciledThrough,
      io,
    });

    assert.equal(io.remaining(), 0, 'nothing is asked');
    assert.equal(result.stopped, false);
    assert.equal(complete(result), false, 'one is not in Actual');
    assert.deepEqual(
      result.outcomes
        .filter((o) => o.action === 'left-out')
        .map((o) => `#${o.classified.number} ${o.classified.source.payee}`),
      ['#17 NEWSAGENT'],
    );
    const after = await session.gateway.getAccountHistory(accountId);
    assert.equal(after.length, existing.length + TO_REVIEW.length);
    assert.equal(
      after.find((t) => t.id === scenario.amountMismatchId)!.amount,
      -7500,
      'the bank amount is taken',
    );
    const written = (ref: string) =>
      after.find((t) => t.imported_id === `${scenario.tag}-${ref}`);
    // On the reconciled-through date is written like any other (ADR 0005).
    assert.equal(written('T-9002')?.date, '2030-06-30');
    assert.equal(written('T-9003'), undefined);
    // The reconciled transaction KIOSK sits beside is untouched.
    assert.deepEqual(
      after.find((t) => t.id === scenario.reconciledId),
      existing.find((t) => t.id === scenario.reconciledId),
    );

    const transcript = io.transcript.join('\n');
    assert.match(
      transcript,
      /^ {4}- 11 to import\n {4}- 1 left out, in the reconciled period$/m,
    );
    assert.match(
      transcript,
      /^ +17 2030-06-29 +-5\.20 NEWSAGENT +left out: reconciled period$/m,
    );
    assert.doesNotMatch(transcript, /──|> /, 'no block and no prompt');
    assert.match(
      transcript,
      /^ {2}correcting in Actual\n {2}~ #13 PRICE CHANGED: -80\.00 → -75\.00$/m,
    );
    assert.deepEqual(io.transcript.slice(-2), [
      '11 imported, 1 corrected, 1 left out, 4 already in Actual.',
      'Run again with --review to import what was left out.',
    ]);
  });

  it('unattended, a second run writes nothing and leaves out the same one', async () => {
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('unattended-again');
    const source = withOneBeforeReconciled(scenario);
    const options = {
      mode: 'unattended' as const,
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      reconciledThrough,
    };
    await importStatement({
      ...options,
      classified: classify(source, existing, reconciledThrough),
      io: createScriptedIo([]),
    });
    const afterFirst = await session.gateway.getAccountHistory(accountId);

    const io = createScriptedIo([]);
    const second = await importStatement({
      ...options,
      classified: classify(source, afterFirst, reconciledThrough),
      io,
    });
    assert.deepEqual(
      second.outcomes.map((o) => o.action),
      ['left-out'],
    );
    assert.equal(io.transcript.at(-2), '0 imported, 1 left out, 16 already in Actual.');
    assert.equal(
      (await session.gateway.getAccountHistory(accountId)).length,
      afterFirst.length,
    );
  });

  it('under review, imports one dated before the reconciled-through date, and says it changes a reconciled balance', async () => {
    // Reported from a real run (#82): transactions deleted from Actual to be
    // imported again were set aside as "locked". Unattended leaves them out;
    // review is how they get in.
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('reconciled-period');
    const classified = classify(
      withOneBeforeReconciled(scenario),
      existing,
      reconciledThrough,
    );
    const newsagent = classified.find((c) => c.source.payee === 'NEWSAGENT')!;
    const io = createScriptedIo(['i']);

    const result = await importStatement({
      mode: 'review',
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified: [newsagent],
      reconciledThrough,
      io,
    });

    assert.equal(complete(result), true);
    const transcript = io.transcript.join('\n');
    assert.match(transcript, /── 1 of 1 ─+\n {2}#17 +2030-06-29 +-5\.20 +NEWSAGENT/);
    assert.match(
      transcript,
      /! dated in your reconciled period: importing it changes a reconciled balance/,
    );
    const after = await session.gateway.getAccountHistory(accountId);
    const written = after.find((t) => t.imported_id === `${scenario.tag}-T-9003`);
    assert.equal(written?.date, '2030-06-29');
    assert.equal(written.amount, -520);
  });

  it('under review, one on the reconciled-through date carries no warning', async () => {
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('reconciled-date');
    const classified = classify(scenario.source, existing, reconciledThrough);
    const io = createScriptedIo(['l', 'q']);

    await importStatement({
      mode: 'review',
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified,
      reconciledThrough,
      io,
    });

    const transcript = io.transcript.join('\n');
    assert.match(transcript, /── 2 of 12 ─+\n {2}#2 +2030-06-30 +-3\.00 +KIOSK/);
    assert.doesNotMatch(transcript, /reconciled period/);
  });

  it('under review, asks about a correction first and never about a pair', async () => {
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('correct-in-review');
    const classified = classify(scenario.source, existing, reconciledThrough);
    const io = createScriptedIo(['?', 'c', 'q']);

    const result = await importStatement({
      mode: 'review',
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified,
      reconciledThrough,
      io,
    });

    const transcript = io.transcript.join('\n');
    assert.match(transcript, /^ {4}- 5 already in Actual\n {4}- 11 to review$/m);
    assert.match(
      transcript,
      /^ {2}correcting in Actual, if you confirm\n {2}~ #13 PRICE CHANGED: -80\.00 → -75\.00$/m,
    );
    assert.match(
      transcript,
      /── 1 of 12 ─+\n {2}#13 +2031-03-15 +-75\.00 +PRICE CHANGED\n.*\n {2}in Actual at -80\.00 · correct it to the bank's -75\.00\n {2}\[c\]orrect {2}\[l\]eave {2}\[\?\] detail {2}\[q\]uit > \?/,
    );
    assert.match(transcript, /^ {2}actual {3}date {9}2031-03-15$/m);
    assert.match(transcript, /> c {2,}corrected to -75\.00$/m);
    assert.doesNotMatch(transcript, /clean|suspicious|skip|locked/);
    assert.deepEqual(
      result.outcomes.map((o) => [o.kind, o.action, o.wrote]),
      [
        ['correction', 'correct', 'corrected'],
        ['write', 'quit', 'nothing'],
      ],
    );
    const after = await session.gateway.getAccountHistory(accountId);
    assert.equal(after.find((t) => t.id === scenario.amountMismatchId)!.amount, -7500);
    assert.equal(after.length, existing.length, 'nothing else is written');
  });

  it('unattended, leaves a reconciled pair uncorrected and says how to correct it', async () => {
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('correct-reconciled');
    await session.api.updateTransaction(scenario.amountMismatchId, {
      reconciled: true,
    });
    await session.api.sync();
    const reread = await session.gateway.getAccountHistory(accountId);
    const classified = classify(scenario.source, reread, reconciledThrough);
    const io = createScriptedIo([]);

    const result = await importStatement({
      mode: 'unattended',
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified,
      reconciledThrough,
      io,
    });

    assert.equal(complete(result), false);
    assert.match(
      io.transcript.join('\n'),
      /^ {2}! #13 PRICE CHANGED: Actual holds -80\.00, the bank says -75\.00 \(reconciled\)$/m,
    );
    assert.deepEqual(io.transcript.slice(-2), [
      '11 imported, 1 to fix in Actual, 4 already in Actual.',
      'Run again with --review to correct what is reconciled.',
    ]);
    const after = await session.gateway.getAccountHistory(accountId);
    assert.equal(after.find((t) => t.id === scenario.amountMismatchId)!.amount, -8000);
    assert.equal(after.length, existing.length + TO_REVIEW.length);
  });

  it('says which statement transaction took a lookalike, and shows it in full on [?]', async () => {
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('lookalike');
    const classified = classify(scenario.source, existing, reconciledThrough);
    const coffee = classified.find((c) => c.number === 8)!;
    const io = createScriptedIo(['?', 'l']);

    await importStatement({
      mode: 'review',
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified: [coffee],
      reconciledThrough,
      io,
    });

    // Actual title-cases payee names it creates, so match case-insensitively.
    const transcript = io.transcript.join('\n');
    assert.match(
      transcript,
      /^ {2}not in Actual · looks like #7's pair: 2031-03-09 -4\.50 Coffee \(typed by hand\)$/im,
    );
    assert.match(transcript, /in Actual, the pair of #7/);
    assert.match(transcript, /line 18 of the file/);
    assert.match(
      transcript,
      /\[i\]mport {2}\[l\]eave {2}\[\?\] detail {2}\[q\]uit > l/,
    );
  });

  it('a second run of the same statement has nothing to review', async () => {
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('idempotent');
    const first = classify(scenario.source, existing, reconciledThrough);
    const firstResult = await importStatement({
      mode: 'review',
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified: first,
      reconciledThrough,
      io: createScriptedIo(['c', ...TO_REVIEW.map(() => 'i')]),
    });
    assert.equal(firstResult.outcomes.filter((o) => o.wrote === 'added').length, 11);
    assert.equal(firstResult.outcomes.filter((o) => o.wrote === 'corrected').length, 1);

    const afterFirst = await session.gateway.getAccountHistory(accountId);
    const second = classify(scenario.source, afterFirst, reconciledThrough);
    // The reference-less twins pair one to one with the two the first run wrote.
    assert.deepEqual(tally(second), { paired: 16, toReview: 0 });

    const io = createScriptedIo([]);
    const secondResult = await importStatement({
      mode: 'review',
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified: second,
      reconciledThrough,
      io,
    });
    assert.deepEqual(secondResult, { outcomes: [], stopped: false });
    assert.match(io.transcript.join('\n'), /- 16 already in Actual\n {4}- 0 to review/);
    assert.equal(
      (await session.gateway.getAccountHistory(accountId)).length,
      afterFirst.length,
    );
  });

  it('unattended, a failed write stops the run and says what was written', async () => {
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('failed-write');
    const classified = classify(scenario.source, existing, reconciledThrough);
    const io = createScriptedIo([]);
    // Never opened, so its first write throws, as a write to a server gone
    // away would.
    const gateway = new ActualGateway(await testSettings());

    await assert.rejects(
      importStatement({
        mode: 'unattended',
        gateway,
        accountId,
        period: PERIOD,
        unpaired: [],
        classified,
        reconciledThrough,
        io,
      }),
      /not open/,
    );
    assert.equal(io.transcript.at(-1), '0 imported, 5 already in Actual.');
    assert.equal(
      (await session.gateway.getAccountHistory(accountId)).length,
      existing.length,
    );
  });

  it('on a quit, counts a correction not reached as still to fix', async () => {
    const { accountId, scenario, reconciledThrough } =
      await arrange('quit-corrections');
    // A second correction: #16 UBS TWINT, held at -160.00 where the bank says -150.00.
    await session.api.addTransactions(accountId, [
      {
        date: '2031-03-25',
        amount: -16000,
        imported_id: `${scenario.tag}-T-0010`,
        payee_name: 'UBS TWINT',
      },
    ]);
    await session.api.sync();
    const existing = await session.gateway.getAccountHistory(accountId);
    const classified = classify(scenario.source, existing, reconciledThrough);
    const io = createScriptedIo(['q']);

    const result = await importStatement({
      mode: 'review',
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified,
      reconciledThrough,
      io,
    });

    assert.deepEqual(
      result.outcomes.map((o) => [o.kind, o.action]),
      [
        ['correction', 'quit'],
        ['correction', 'quit'],
      ],
    );
    assert.ok(io.transcript.some((l) => l.endsWith('stopped, 12 left untouched')));
    assert.equal(
      io.transcript.at(-1),
      '0 imported, 10 left, 2 to fix in Actual, 4 already in Actual.',
    );
  });

  it('stops the run on quit and leaves the rest untouched', async () => {
    const { accountId, scenario, existing, reconciledThrough } = await arrange('quit');
    const classified = classify(scenario.source, existing, reconciledThrough);
    const io = createScriptedIo(['l', 'q']);

    const result = await importStatement({
      mode: 'review',
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified,
      reconciledThrough,
      io,
    });

    assert.equal(result.stopped, true);
    assert.equal(result.outcomes.length, 2);
    assert.equal(result.outcomes[1]!.action, 'quit');
    assert.ok(io.transcript.some((l) => l.endsWith('stopped, 11 left untouched')));
    assert.equal(
      (await session.gateway.getAccountHistory(accountId)).length,
      existing.length,
    );
  });
});
