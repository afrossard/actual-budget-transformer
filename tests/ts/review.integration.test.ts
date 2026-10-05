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
import { review } from '../../src/review.ts';
import {
  closeSession,
  createRunAccount,
  openSession,
  seedScenario,
  serverReachable,
  skipReason,
  type Scenario,
  type Session,
} from './actual-fixture.ts';

const skip = skipReason(await serverReachable());

/** The seeded statement's period; what Actual holds outside its pairs is not listed here. */
const PERIOD = { from: '2030-06-01', to: '2031-03-31' };

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

describe('integration: the review loop', { skip }, () => {
  let session: Session;

  before(async () => {
    session = await openSession();
  });

  after(async () => {
    await closeSession(session);
  });

  /** A fresh account, seeded, read the way a run reads it. */
  async function arrange(label: string): Promise<{
    accountId: string;
    scenario: Scenario;
    existing: ActualTransaction[];
    reconciledThrough: string | null;
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
    const io = createScriptedIo(TO_REVIEW.map(() => 'l'));

    const result = await review({
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
      TO_REVIEW.length,
      'only the unpaired are asked',
    );
    assert.equal(
      result.outcomes.every((o) => o.wrote === 'nothing'),
      true,
    );
    assert.deepEqual(await session.gateway.getAccountHistory(accountId), existing);
    assert.equal(io.transcript.at(-1), '0 imported, 11 left, 5 already in Actual.');
  });

  it('imports one missing on the reconciled-through date, and says it changes a reconciled balance', async () => {
    // Reported from a real run (#82): transactions deleted from Actual on the
    // same day as the last reconciled one were set aside as "locked".
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('reconciled-period');
    const classified = classify(scenario.source, existing, reconciledThrough);
    const io = createScriptedIo(['i', 'q']);

    await review({
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified,
      reconciledThrough,
      io,
    });

    const transcript = io.transcript.join('\n');
    assert.match(transcript, /── 1 of 11 ─+\n {2}#2 +2030-06-30 +-3\.00 +KIOSK/);
    assert.match(
      transcript,
      /! dated in your reconciled period: importing it changes a reconciled balance/,
    );
    const after = await session.gateway.getAccountHistory(accountId);
    const kiosk = after.find((t) => t.imported_id === `${scenario.tag}-T-9002`);
    assert.equal(kiosk?.date, '2030-06-30');
    assert.equal(kiosk.amount, -300);
    // The reconciled transaction it sits beside is untouched.
    assert.deepEqual(
      after.find((t) => t.id === scenario.reconciledId),
      existing.find((t) => t.id === scenario.reconciledId),
    );
  });

  it('never asks about a pair, and lists the one Actual needs fixed', async () => {
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('fix-in-actual');
    const classified = classify(scenario.source, existing, reconciledThrough);
    const io = createScriptedIo(['q']);

    await review({
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
      /^ {2}! #13 PRICE CHANGED: Actual holds -80\.00, the bank says -75\.00$/m,
    );
    assert.doesNotMatch(transcript, /clean|suspicious|skip|locked/);
    const after = await session.gateway.getAccountHistory(accountId);
    assert.equal(
      after.find((t) => t.id === scenario.amountMismatchId)!.amount,
      -8000,
      'nothing is written for a pair',
    );
  });

  it('says which statement transaction took a lookalike, and shows it in full on [?]', async () => {
    const { accountId, scenario, existing, reconciledThrough } =
      await arrange('lookalike');
    const classified = classify(scenario.source, existing, reconciledThrough);
    const coffee = classified.find((c) => c.number === 8)!;
    const io = createScriptedIo(['?', 'l']);

    await review({
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
    const firstResult = await review({
      gateway: session.gateway,
      accountId,
      period: PERIOD,
      unpaired: [],
      classified: first,
      reconciledThrough,
      io: createScriptedIo(TO_REVIEW.map(() => 'i')),
    });
    assert.equal(firstResult.outcomes.filter((o) => o.wrote === 'added').length, 11);

    const afterFirst = await session.gateway.getAccountHistory(accountId);
    const second = classify(scenario.source, afterFirst, reconciledThrough);
    // The reference-less twins pair one to one with the two the first run wrote.
    assert.deepEqual(tally(second), { paired: 16, toReview: 0 });

    const io = createScriptedIo([]);
    const secondResult = await review({
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

  it('stops the run on quit and leaves the rest untouched', async () => {
    const { accountId, scenario, existing, reconciledThrough } = await arrange('quit');
    const classified = classify(scenario.source, existing, reconciledThrough);
    const io = createScriptedIo(['l', 'q']);

    const result = await review({
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
    assert.ok(io.transcript.some((l) => l.endsWith('stopped, 10 left untouched')));
    assert.equal(
      (await session.gateway.getAccountHistory(accountId)).length,
      existing.length,
    );
  });
});
