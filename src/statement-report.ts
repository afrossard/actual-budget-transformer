/**
 * The statement report, printed before anything is written: what the
 * statement holds and what Actual holds, the corrections, the pairs Actual
 * needs fixed, the Actual transactions the statement does not hold, and one
 * line per unpaired statement transaction - to import, or left out for being
 * in the reconciled period, or under review to review. Then, under review, one
 * block per statement transaction or correction as it is reviewed, and what
 * `[?]` shows.
 *
 * Paired statement transactions are never listed one by one: they are already
 * in Actual. The exceptions are a correction (ADR 0007), and a pair whose
 * amount differs but cannot be corrected here, which is listed to be fixed in
 * Actual. So is every unpaired Actual transaction: nothing is ever written for
 * one.
 *
 * Every line is fitted to the terminal and cut with `…`. A line that wraps puts
 * its tail in column 0, and from there on the columns stop meaning anything
 * (#81). Nothing is lost by cutting: `[?]` shows everything in full.
 */
import { formatCents } from './money.ts';
import {
  correctionOf,
  tally,
  type ActualTransaction,
  type Classified,
  type Correction,
  type Lookalike,
  type UnpairedActual,
} from './classify.ts';
import type { DroppedRow, Period, SourceTransaction } from './sources/types.ts';
import type { IsoDate } from './iso-date.ts';

const ESC = `${String.fromCharCode(27)}[`;
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const WARN = `${ESC}33m`;

export type ReportStyle = {
  colour: boolean;
  /** The terminal's width in columns; every line is fitted to it. */
  width: number;
};

/** The width when there is no terminal to ask, as in a pipe or a log. */
export const DEFAULT_WIDTH = 80;

/**
 * How wide to lay the report out on this stream. Some pseudo-terminals report
 * a width of 0, and fitting to that would print every line empty.
 */
export function terminalWidth(stream: { isTTY?: boolean; columns?: number }): number {
  const columns = stream.isTTY === true ? (stream.columns ?? 0) : 0;
  return columns > 0 ? columns : DEFAULT_WIDTH;
}

export type Segment = { text: string; code?: string | undefined };

/**
 * Lay segments out on one line no wider than `width`, cutting the first one
 * that does not fit with `…` and dropping the rest. Trailing padding goes, so a
 * short line does not end in spaces.
 */
export function fit(
  segments: readonly Segment[],
  width: number,
  style: Pick<ReportStyle, 'colour'>,
): string {
  const kept: Segment[] = [];
  let room = width;
  for (const segment of segments) {
    if (segment.text.length <= room) {
      kept.push(segment);
      room -= segment.text.length;
      continue;
    }
    if (room > 0)
      kept.push({ ...segment, text: `${segment.text.slice(0, room - 1)}…` });
    break;
  }
  for (let last = kept.at(-1); last !== undefined; last = kept.at(-1)) {
    const text = last.text.trimEnd();
    if (text !== '') {
      kept[kept.length - 1] = { ...last, text };
      break;
    }
    kept.pop();
  }
  return kept
    .map(({ text, code }) =>
      style.colour && code !== undefined ? `${code}${text}${RESET}` : text,
    )
    .join('');
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function amount(cents: number): string {
  return formatCents(cents).trim();
}

/** A lookalike in a few words: whose it is. */
function lookalikeName(lookalike: Lookalike): string {
  switch (lookalike.role) {
    case 'pair':
      return `#${lookalike.of}'s pair`;
    case 'extra-holder':
      return `#${lookalike.of}'s duplicate`;
  }
}

/**
 * How a run treats the unpaired statement transactions: write them without
 * asking, except one in the reconciled period, which it leaves out; or review
 * each one (ADR 0005).
 */
export type Mode = 'unattended' | 'review';

/** The list's `note` column: what to know about it, in a few words. */
export function noteTag(classified: Classified, mode: Mode): string {
  const { lookalikes, repeatOf, inReconciledPeriod } = classified;
  const { pending } = classified.source;
  const [only] = lookalikes;
  const reconciled =
    mode === 'unattended' ? 'left out: reconciled period' : 'reconciled period';
  return [
    ...(inReconciledPeriod ? [reconciled] : []),
    // Its amount is not final, and unattended nothing else says so (#47).
    ...(pending === undefined
      ? []
      : pending.originalCurrency === pending.accountCurrency
        ? ['pending']
        : [`pending, in ${pending.originalCurrency}`]),
    ...(only === undefined
      ? []
      : lookalikes.length === 1
        ? [`like ${lookalikeName(only)}`]
        : [`like ${lookalikes.length} pairs`]),
    ...(repeatOf === null ? [] : [`same as #${repeatOf}`]),
  ].join(' · ');
}

/**
 * The review list's column widths, single-sourced.
 *
 * The header is built from these rather than written out, because a header whose
 * labels sit a column off the fields they name is the kind of thing that stays
 * wrong for a long time.
 */
const COLUMN = {
  index: 3,
  date: 10,
  /** Right-aligned, so `formatCents`'s own width has to match. */
  amount: 10,
} as const;

/**
 * The payee takes what the terminal has to spare once the last column - the
 * note, or a block's tags - has its room, between these two. The note comes
 * first: a cut payee is still recognisable, a cut "reconciled period" is not.
 */
const PAYEE = { min: 12, max: 40 } as const;

/** The most room the note column asks for; past that a note is cut. */
const NOTE_ROOM = 36;

const LIST_INDENT = COLUMN.index + 1 + COLUMN.date + 1 + COLUMN.amount + 1;

/** How wide the payee is, with `indent` columns before it and `tagRoom` after. */
function payeeWidth(style: ReportStyle, indent: number, tagRoom: number): number {
  const spare = style.width - indent - (tagRoom === 0 ? 0 : tagRoom + 1);
  return Math.min(PAYEE.max, Math.max(PAYEE.min, spare));
}

function columns(
  style: ReportStyle,
  noteRoom: number,
  cells: { index: string; date: string; amount: string; payee: string; note: Segment },
): Segment[] {
  const payee = payeeWidth(style, LIST_INDENT, noteRoom);
  return [
    {
      text:
        `${cells.index.padStart(COLUMN.index)} ${cells.date.padEnd(COLUMN.date)} ` +
        `${cells.amount.padStart(COLUMN.amount)} `,
    },
    // The payee is cut to its column rather than pushing the note column out.
    { text: clip(cells.payee, payee).padEnd(payee) },
    // A segment of its own: with no note, a payee given all the room ends the
    // line, and `fit` drops a separator it has no room for rather than cut it.
    { text: ' ' },
    cells.note,
  ];
}

export function listHeader(style: ReportStyle, noteRoom = NOTE_ROOM): string {
  return fit(
    columns(style, noteRoom, {
      index: '#',
      date: 'date',
      amount: 'amount',
      payee: 'payee',
      // Nothing has a note, so there is no column to name.
      note: { text: noteRoom === 0 ? '' : 'note' },
    }),
    style.width,
    style,
  );
}

/** One unpaired statement transaction, as the report lists it. */
export function listLine(
  classified: Classified,
  mode: Mode,
  style: ReportStyle,
  /** The same for every line of one report, so that its columns line up. */
  noteRoom = NOTE_ROOM,
): string {
  const { source, number } = classified;
  return fit(
    columns(style, noteRoom, {
      index: String(number),
      date: source.date,
      amount: formatCents(source.amountCents, COLUMN.amount),
      payee: source.payee,
      note: { text: noteTag(classified, mode), code: DIM },
    }),
    style.width,
    style,
  );
}

/**
 * Whether this run makes the correction - unattended, or under review once
 * confirmed - rather than leaving it to be fixed in Actual.
 */
export function corrects(correction: Correction, mode: Mode): boolean {
  return (
    correction.hold === null || (correction.hold === 'reconciled' && mode === 'review')
  );
}

/**
 * `#n payee` then `tail`, no wider than `width`. The payee is cut first,
 * because the amounts are the point, and unattended there is no `[?]` to read
 * them from.
 */
function pairLine({ number, source }: Classified, tail: string, width: number): string {
  const head = `#${number} `;
  const room = Math.max(1, width - head.length - tail.length);
  return `${head}${clip(source.payee, room)}`.trimEnd() + tail;
}

/** The correction this run makes to one pair, if any, on one line. */
export function correctionLines(
  classified: Classified,
  mode: Mode,
  width = Infinity,
): string[] {
  const correction = correctionOf(classified);
  if (correction === null || !corrects(correction, mode)) return [];
  const tail =
    `: ${amount(correction.actualAmount)} → ${amount(classified.source.amountCents)}` +
    (correction.hold === 'reconciled' ? ' (reconciled)' : '');
  return [pairLine(classified, tail, width)];
}

/**
 * What Actual needs fixed about one pair, there rather than here, and why this
 * run did not: `split` or `reconciled`. That review would correct a reconciled
 * one is said once, after the run, as the line has no room for it.
 */
export function fixLines(
  classified: Classified,
  mode: Mode,
  width = Infinity,
): string[] {
  const correction = correctionOf(classified);
  if (correction?.hold == null || corrects(correction, mode)) return [];
  const tail =
    `: Actual holds ${amount(correction.actualAmount)}, ` +
    `the bank says ${amount(classified.source.amountCents)} (${correction.hold})`;
  return [pairLine(classified, tail, width)];
}

const DUPLICATE = 'duplicate, delete one';
const RECONCILED = 'already reconciled, double check reconciliation balance';

/** An Actual transaction the unpaired list shows, and what to know about it. */
type UnpairedRow = { tx: ActualTransaction; note: string };

/**
 * The unpaired list's rows: by date, each duplicate beside its paired twin.
 * The twin is shown but is not unpaired, since which of the two the pairing
 * took is arbitrary.
 */
export function unpairedRows(unpaired: readonly UnpairedActual[]): UnpairedRow[] {
  const byDate = (a: ActualTransaction, b: ActualTransaction): number =>
    a.date.localeCompare(b.date);
  // Never empty, so each has a first transaction to sort by.
  type Group = [ActualTransaction, ...ActualTransaction[]];
  const couples = new Map<string, Group>();
  const groups: Group[] = [];
  for (const { actual, twin } of unpaired) {
    if (twin === null) {
      groups.push([actual]);
      continue;
    }
    const couple = couples.get(twin.id);
    if (couple !== undefined) couple.push(actual);
    else {
      const created: Group = [twin, actual];
      couples.set(twin.id, created);
      groups.push(created);
    }
  }
  // Stable sorts: on a tie the twin stays first, and the order Actual gave stays.
  for (const group of groups) group.sort(byDate);
  groups.sort((a, b) => byDate(a[0], b[0]));
  return groups.flatMap((group) =>
    group.map((tx) => ({
      tx,
      note:
        group.length > 1
          ? DUPLICATE + (tx.reconciled ? ' · reconciled' : '')
          : tx.reconciled
            ? RECONCILED
            : '',
    })),
  );
}

/** Where the unpaired list's payee starts: `  ! `, the date and the amount. */
const UNPAIRED_INDENT = 4 + COLUMN.date + 1 + COLUMN.amount + 2;

/** Where a note that does not fit beside its payee goes, on a line of its own. */
const HUNG_NOTE = ' '.repeat(6);

/**
 * The Actual transactions the statement does not hold, one line each.
 *
 * A note too long to sit beside even the narrowest payee hangs below instead,
 * wrapped rather than cut: there is no `[?]` here to show it in full.
 */
export function unpairedLines(
  unpaired: readonly UnpairedActual[],
  style: ReportStyle,
): string[] {
  const rows = unpairedRows(unpaired);
  const room = style.width - UNPAIRED_INDENT - PAYEE.min - 1;
  const fits = (note: string): boolean => note.length <= room;
  const noteRoom = Math.max(
    0,
    ...rows.map((r) => r.note.length).filter((length) => length <= room),
  );
  const payee = payeeWidth(style, UNPAIRED_INDENT, noteRoom);
  return rows.flatMap(({ tx, note }) => {
    const head =
      `  ! ${tx.date.padEnd(COLUMN.date)} ` +
      `${formatCents(tx.amount, COLUMN.amount)}  `;
    const name = clip(tx.payeeName ?? '', payee).padEnd(payee);
    const segments = [head, name, ' ', fits(note) ? note : ''];
    const hung = fits(note)
      ? []
      : wrap(note, Math.max(1, style.width - HUNG_NOTE.length)).map(
          (part) => HUNG_NOTE + part,
        );
    return [
      fit(
        segments.map((text) => ({ text, code: WARN })),
        style.width,
        style,
      ),
      ...hung.map((text) => fit([{ text, code: WARN }], style.width, style)),
    ];
  });
}

/** What is printed before the first prompt: the statement at a glance. */
export function report(
  statement: {
    /** The dates the statement covers. */
    period: Period;
    classified: readonly Classified[];
    unpaired: readonly UnpairedActual[];
    reconciledThrough: IsoDate | null;
    dropped: readonly DroppedRow[];
    mode: Mode;
  },
  style: ReportStyle,
): string[] {
  const { period, classified, unpaired, reconciledThrough, dropped, mode } = statement;
  const { paired, toReview } = tally(classified);
  const leftOut = classified.filter((c) => c.pair === null && c.inReconciledPeriod);
  const line = (text: string, code?: string): string =>
    fit([{ text, code }], style.width, style);
  const lines = [
    line('  Statement'),
    line(`    - From ${period.from} to ${period.to}`),
    line(`    - ${plural(classified.length, 'transaction', 'transactions')} found`),
    line(`    - ${paired} already in Actual`),
    ...(mode === 'review'
      ? [line(`    - ${toReview} to review`)]
      : [
          line(`    - ${toReview - leftOut.length} to import`),
          ...(leftOut.length > 0
            ? [line(`    - ${leftOut.length} left out, in the reconciled period`)]
            : []),
        ]),
  ];
  if (dropped.length > 0) {
    lines.push(
      line(
        dropped.length === 1
          ? '    - 1 row in the file was not read as a transaction:'
          : `    - ${dropped.length} rows in the file were not read as transactions:`,
      ),
    );
    for (const row of dropped)
      lines.push(line(`        line ${row.sourceLine}: ${row.reason}`));
  }
  lines.push(
    line('  Actual'),
    line(
      reconciledThrough === null
        ? '    - Nothing reconciled yet'
        : `    - Reconciled through ${reconciledThrough}`,
    ),
    line(`    - ${unpaired.length} not in the statement`),
  );
  const room = style.width - '  ! '.length;
  const corrections = classified.flatMap((c) => correctionLines(c, mode, room));
  if (corrections.length > 0) {
    lines.push(
      '',
      line(
        mode === 'review'
          ? '  correcting in Actual, if you confirm'
          : '  correcting in Actual',
      ),
    );
    for (const correction of corrections) lines.push(line(`  ~ ${correction}`));
  }
  const fixes = classified.flatMap((c) => fixLines(c, mode, room));
  if (fixes.length > 0) {
    lines.push('', line('  in Actual, but to fix there'));
    for (const fix of fixes) lines.push(line(`  ! ${fix}`, WARN));
  }
  if (unpaired.length > 0) {
    lines.push('', line('  in Actual, not in the statement'));
    lines.push(...unpairedLines(unpaired, style));
  }
  const listed = classified.filter((c) => c.pair === null);
  if (listed.length > 0) {
    const noteRoom = Math.min(
      NOTE_ROOM,
      Math.max(0, ...listed.map((c) => noteTag(c, mode).length)),
    );
    lines.push('', listHeader(style, noteRoom));
    for (const c of listed) lines.push(listLine(c, mode, style, noteRoom));
  }
  return lines;
}

/** The block's columns: label, date, amount, payee. */
const LABEL = 8;
const SIDE_INDENT = 2 + LABEL + 1 + COLUMN.date + 1 + COLUMN.amount + 2;

/** An Actual transaction in a few words, for a lookalike's line. */
function brief(tx: ActualTransaction): string {
  return [tx.date, amount(tx.amount), tx.payeeName ?? ''].join(' ').trimEnd();
}

function lookalikeText(lookalike: Lookalike): string {
  return `looks like ${lookalikeName(lookalike)}: ${brief(lookalike.actual)}`;
}

export type ReviewedBlock = {
  /** Its place among the statement transactions to review, counted from 1. */
  position: number;
  /** How many there are to review. */
  total: number;
  classified: Classified;
  /** Short, one line each; `[?]` has the long form. */
  warnings: readonly string[];
};

/**
 * One reviewed statement transaction: the bank's version under its `#`, then
 * whether anything in Actual is alike to it, then what to watch out for. A
 * paired one is reviewed only for its correction, and says what Actual holds
 * instead.
 */
export function block(reviewed: ReviewedBlock, style: ReportStyle): string[] {
  const { position, total, classified } = reviewed;
  const { source, number, lookalikes, repeatOf } = classified;

  const title = `── ${position} of ${total} `;
  const rule = title + '─'.repeat(Math.max(0, style.width - title.length));
  const payee = payeeWidth(style, SIDE_INDENT, 0);

  const lines = [
    fit([{ text: rule, code: DIM }], style.width, style),
    fit(
      [
        {
          text:
            `  ${`#${number}`.padEnd(LABEL)} ${source.date.padEnd(COLUMN.date)} ` +
            `${formatCents(source.amountCents, COLUMN.amount)}  `,
        },
        { text: clip(source.payee, payee) },
      ],
      style.width,
      style,
    ),
  ];
  if (source.notes !== '') {
    lines.push(
      fit(
        [{ text: ' '.repeat(SIDE_INDENT) }, { text: source.notes, code: DIM }],
        style.width,
        style,
      ),
    );
  }

  // A paired one has no lookalikes: they are looked for only when unpaired.
  const status =
    classified.pair === null
      ? '  not in Actual'
      : `  in Actual at ${amount(classified.pair.actual.amount)} · ` +
        `correct it to the bank's ${amount(source.amountCents)}`;
  const [first, ...more] = lookalikes;
  lines.push(
    fit(
      [{ text: status }, { text: first ? ` · ${lookalikeText(first)}` : '' }],
      style.width,
      style,
    ),
  );
  // Further lookalikes hang under the first, so each reads as its own line.
  for (const lookalike of more) {
    lines.push(
      fit(
        [{ text: ' '.repeat(status.length + 3) }, { text: lookalikeText(lookalike) }],
        style.width,
        style,
      ),
    );
  }
  if (repeatOf !== null) {
    lines.push(
      fit([{ text: `  identical to #${repeatOf} in this file` }], style.width, style),
    );
  }
  for (const warning of reviewed.warnings) {
    lines.push(fit([{ text: `  ! ${warning}`, code: WARN }], style.width, style));
  }
  return lines;
}

/**
 * Break `text` into lines no wider than `width`, at spaces where it can and
 * inside a word only when the word alone is wider than a line. The detail
 * wraps where the block cuts, because showing everything is its whole job.
 */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(' ')) {
    while (word.length > width) {
      if (line !== '') lines.push(line);
      lines.push(word.slice(0, width));
      word = word.slice(width);
      line = '';
    }
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * Why a statement transaction is reviewed, one phrase per reason, for `[?]`.
 *
 * A phrase never describes an Actual transaction: the detail lists each
 * lookalike once, beside these, and a correction's pair.
 */
export function explain(classified: Classified): string[] {
  const { source, lookalikes, repeatOf, inReconciledPeriod } = classified;
  if (classified.pair !== null) {
    return [
      `paired by imported ID, and the bank booked it at ${amount(source.amountCents)}`,
    ];
  }
  const why =
    lookalikes.length > 0
      ? 'an Actual transaction alike to it belongs to another statement transaction'
      : 'no Actual transaction holds its imported ID or has its amount within a ' +
        'day of it';
  return [
    `not in Actual: ${why}`,
    ...(repeatOf === null
      ? []
      : [`identical to #${repeatOf} in this file, which the bank lists as well`]),
    ...(inReconciledPeriod ? [`dated ${source.date}, in your reconciled period`] : []),
  ];
}

const KEY = 13;
const DETAIL_INDENT = 2 + LABEL + 1;

const ORIGIN: Record<SourceTransaction['importedIdOrigin'], string> = {
  'bank-reference': "the bank's reference",
  minted: 'minted from the transaction, as this format carries no reference',
  absent: 'none: the bank wrote no reference',
  pending: 'none: the bank has not booked it, and renumbers it when it does',
};

/**
 * What `[?]` shows: why it is reviewed, then every field of the bank's version
 * and of each lookalike, uncut. Laid out under labels like the block, and
 * wrapped to the terminal rather than cut.
 */
export function detail(classified: Classified, style: ReportStyle): string[] {
  const { source } = classified;
  const lines: string[] = [];
  // A section's label goes on its first line. A keyed value starts after the
  // key; an unkeyed one where the key would. Wrapped lines hang under the
  // value, and an empty field is left out rather than shown blank.
  const section = (
    label: string,
    fields: readonly (readonly [string, string])[],
  ): void => {
    const present = fields.filter(([, value]) => value !== '');
    for (const [i, [key, value]] of present.entries()) {
      const indent = DETAIL_INDENT + (key === '' ? 0 : KEY);
      const head = `  ${(i === 0 ? label : '').padEnd(LABEL)} ${key.padEnd(indent - DETAIL_INDENT)}`;
      for (const [j, part] of wrap(
        value,
        Math.max(1, style.width - indent),
      ).entries()) {
        lines.push((j === 0 ? head : ' '.repeat(indent)) + part);
      }
    }
  };

  section(
    'why',
    explain(classified).map((why) => ['', why] as const),
  );
  section('bank', [
    ['', `line ${source.sourceLine} of the file`],
    ['payee', source.payee],
    ['notes', source.notes],
    [
      'imported ID',
      source.importedId === ''
        ? ORIGIN[source.importedIdOrigin]
        : `${source.importedId}, ${ORIGIN[source.importedIdOrigin]}`,
    ],
  ]);
  // Every field of an Actual transaction, uncut.
  const fields = (tx: ActualTransaction): (readonly [string, string])[] => {
    const parts = tx.subtransactions ?? [];
    return [
      ['date', tx.date],
      ['amount', amount(tx.amount)],
      ['payee', tx.payeeName ?? ''],
      ['notes', tx.notes ?? ''],
      ['imported ID', tx.imported_id ?? 'none'],
      ...(parts.length > 0
        ? [['split into', parts.map((p) => amount(p.amount)).join(', ')] as const]
        : []),
      ...(tx.reconciled ? [['reconciled', 'yes'] as const] : []),
    ];
  };
  // Reviewed for its correction: the transaction it corrects.
  if (classified.pair !== null) section('actual', fields(classified.pair.actual));
  for (const lookalike of classified.lookalikes) {
    const whose = {
      pair: `in Actual, the pair of #${lookalike.of}`,
      'extra-holder': `in Actual, a second holder of #${lookalike.of}'s imported ID`,
    }[lookalike.role];
    section('alike', [['', whose], ...fields(lookalike.actual)]);
  }
  return lines;
}
