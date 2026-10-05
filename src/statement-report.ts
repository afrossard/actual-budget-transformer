/**
 * The statement report, printed before any review: what the statement holds
 * and what Actual holds, the pairs Actual needs fixed, the Actual transactions
 * the statement does not hold, and one line per statement transaction to
 * review. Then one block per statement transaction as it is reviewed, and what
 * `[?]` shows.
 *
 * Paired statement transactions are never listed one by one: they are already
 * in Actual. The exception is a pair Actual needs fixed, which is listed and
 * never prompted, because the fix is made in Actual. So is every unpaired
 * Actual transaction: nothing is ever written for one.
 *
 * Every line is fitted to the terminal and cut with `…`. A line that wraps puts
 * its tail in column 0, and from there on the columns stop meaning anything
 * (#81). Nothing is lost by cutting: `[?]` shows everything in full.
 */
import { formatCents } from './money.ts';
import {
  tally,
  toFixInActual,
  type ActualTransaction,
  type Classified,
  type Lookalike,
  type UnpairedActual,
} from './classify.ts';
import type { DroppedRow, Period, SourceTransaction } from './sources/types.ts';

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

/** A lookalike in a few words: whose it is, or under which reference. */
function lookalikeName(lookalike: Lookalike): string {
  switch (lookalike.role) {
    case 'pair':
      return `#${lookalike.of}'s pair`;
    case 'extra-holder':
      return `#${lookalike.of}'s duplicate`;
    case 'other-reference':
      return lookalike.actual.imported_id ?? '';
  }
}

/** The review list's `note` column: what to know about it, in a few words. */
export function noteTag(classified: Classified): string {
  const { lookalikes, repeatOf, inReconciledPeriod } = classified;
  const [only] = lookalikes;
  return [
    ...(inReconciledPeriod ? ['reconciled period'] : []),
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

/** One statement transaction to review, as the report lists it. */
export function listLine(
  classified: Classified,
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
      note: { text: noteTag(classified), code: DIM },
    }),
    style.width,
    style,
  );
}

/** What Actual needs fixed about one pair, one line each. */
export function fixLines(classified: Classified): string[] {
  const { number, source } = classified;
  const subject = `#${number} ${source.payee}`.trimEnd();
  return toFixInActual(classified).map(
    (fix) =>
      `${subject}: Actual holds ${amount(fix.actualAmount)}, ` +
      `the bank says ${amount(source.amountCents)}`,
  );
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
    reconciledThrough: string | null;
    dropped: readonly DroppedRow[];
  },
  style: ReportStyle,
): string[] {
  const { period, classified, unpaired, reconciledThrough, dropped } = statement;
  const { paired, toReview } = tally(classified);
  const line = (text: string, code?: string): string =>
    fit([{ text, code }], style.width, style);
  const lines = [
    line('  Statement'),
    line(`    - From ${period.from} to ${period.to}`),
    line(`    - ${plural(classified.length, 'transaction', 'transactions')} found`),
    line(`    - ${paired} already in Actual`),
    line(`    - ${toReview} to review`),
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
  const fixes = classified.flatMap(fixLines);
  if (fixes.length > 0) {
    lines.push('', line('  in Actual, but to fix there'));
    for (const fix of fixes) lines.push(line(`  ! ${fix}`, WARN));
  }
  if (unpaired.length > 0) {
    lines.push('', line('  in Actual, not in the statement'));
    lines.push(...unpairedLines(unpaired, style));
  }
  const reviewed = classified.filter((c) => c.pair === null);
  if (reviewed.length > 0) {
    const noteRoom = Math.min(
      NOTE_ROOM,
      Math.max(0, ...reviewed.map((c) => noteTag(c).length)),
    );
    lines.push('', listHeader(style, noteRoom));
    for (const c of reviewed) lines.push(listLine(c, style, noteRoom));
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
 * whether anything in Actual is alike to it, then what to watch out for.
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

  const status = '  not in Actual';
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
 * lookalike once, beside these.
 */
export function explain(classified: Classified): string[] {
  const { source, lookalikes, repeatOf, inReconciledPeriod } = classified;
  const why = [
    ...(lookalikes.some((l) => l.role !== 'other-reference')
      ? ['an Actual transaction alike to it belongs to another statement transaction']
      : []),
    ...(lookalikes.some((l) => l.role === 'other-reference')
      ? [
          'an Actual transaction alike to it carries another bank reference, so it ' +
            'is a different transaction',
        ]
      : []),
  ];
  const [
    first = 'no Actual transaction holds its imported ID or has its amount ' +
      'within a day of it',
    ...more
  ] = why;
  return [
    `not in Actual: ${first}`,
    ...more,
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
        ? ORIGIN.absent
        : `${source.importedId}, ${ORIGIN[source.importedIdOrigin]}`,
    ],
  ]);
  for (const lookalike of classified.lookalikes) {
    const tx = lookalike.actual;
    const parts = tx.subtransactions ?? [];
    const whose = {
      pair: `in Actual, the pair of #${lookalike.of}`,
      'extra-holder': `in Actual, a second holder of #${lookalike.of}'s imported ID`,
      'other-reference': `in Actual under bank reference ${tx.imported_id ?? ''}, so a different transaction`,
    }[lookalike.role];
    section('alike', [
      ['', whose],
      ['date', tx.date],
      ['amount', amount(tx.amount)],
      ['payee', tx.payeeName ?? ''],
      ['notes', tx.notes ?? ''],
      ['imported ID', tx.imported_id ?? 'none'],
      ...(parts.length > 0
        ? [['split into', parts.map((p) => amount(p.amount)).join(', ')] as const]
        : []),
      ...(tx.reconciled ? [['reconciled', 'yes'] as const] : []),
    ]);
  }
  return lines;
}
