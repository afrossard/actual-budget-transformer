/**
 * The Tape: one line per source transaction up front, then one block per row
 * as it is reviewed, with the bank's version and Actual's lined up.
 *
 * A decline is a decision. Skip and Locked rows get a line and a prompt like
 * every other row, because that is where the tool would be throwing bank data
 * away, and bank data is never dropped on a log line.
 *
 * Every line is fitted to the terminal and cut with `…`. A line that wraps puts
 * its tail in column 0, and from there on the columns stop meaning anything
 * (#81). Nothing is lost by cutting: `[?]` shows the row in full.
 */
import { formatCents } from './money.ts';
import {
  tally,
  type ActualTransaction,
  type ClassifiedRow,
  type Evidence,
  type Bucket,
} from './classify.ts';
import type { DroppedRow, SourceTransaction } from './sources/types.ts';

const ESC = `${String.fromCharCode(27)}[`;
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const WARN = `${ESC}33m`;

const STYLE: Record<Bucket, string> = {
  clean: `${ESC}32m`, // green: nothing in the way
  suspicious: WARN, // yellow: something is
  skip: DIM, // dim: already done
  locked: `${ESC}35m`, // magenta: inside the reconciled range
};

export type TapeStyle = {
  colour: boolean;
  /** The terminal's width in columns; every line is fitted to it. */
  width: number;
};

/** The width when there is no terminal to ask, as in a pipe or a log. */
export const DEFAULT_WIDTH = 80;

/**
 * How wide to lay the Tape out on this stream. Some pseudo-terminals report a
 * width of 0, and fitting to that would print every line empty.
 */
export function terminalWidth(stream: { isTTY?: boolean; columns?: number }): number {
  const columns = stream.isTTY === true ? (stream.columns ?? 0) : 0;
  return columns > 0 ? columns : DEFAULT_WIDTH;
}

/** A source row's `#` on the Tape, from its line in the file. */
export type NumberOf = (sourceLine: number) => number | undefined;

/** Each row's `#` is its position in the batch, counted from 1. */
export function numbering(rows: readonly ClassifiedRow[]): NumberOf {
  const byLine = new Map(rows.map((row, i) => [row.source.sourceLine, i + 1]));
  return (sourceLine) => byLine.get(sourceLine);
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
  style: Pick<TapeStyle, 'colour'>,
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

/**
 * One phrase per reason, in the order the classifier ranked them, for `[?]`.
 *
 * A phrase never describes a stored transaction: the detail lists each match
 * once, beside these, and naming it again here is the repetition #81 removed.
 */
export function explain(reasons: readonly Evidence[], numberOf: NumberOf): string[] {
  return reasons.map((reason) => {
    switch (reason.kind) {
      case 'already-imported':
        // Not a tie to break: one imported ID held twice is corruption in
        // Actual, and fixing it there is likely the right action.
        return reason.matched.length === 1
          ? 'its imported ID is already in Actual'
          : `its imported ID is held by ${reason.matched.length} transactions in Actual, ` +
              'where there should be one: fix that in Actual';
      case 'inside-reconciled-range':
        return `dated on or before the reconciliation boundary ${reason.boundary}`;
      case 'same-amount-within-one-day':
        return `same amount within a day of ${plural(reason.candidates.length, 'transaction', 'transactions')}`;
      case 'repeated-in-this-file':
        return `identical to ${rowRef(reason.firstSeenLine, numberOf)} (line ${reason.firstSeenLine} of this file)`;
      case 'no-match':
        return 'nothing in Actual looks like it';
    }
  });
}

function rowRef(sourceLine: number, numberOf: NumberOf): string {
  const number = numberOf(sourceLine);
  return number === undefined ? `line ${sourceLine}` : `#${number}`;
}

/**
 * Every stored transaction the evidence names, each once, most relevant first.
 *
 * The evidence can name one transaction under several reasons - a Locked row's
 * nearest match is also its blind duplicate - and saying it once is the point.
 */
export function matches(row: ClassifiedRow): ActualTransaction[] {
  const seen = new Map<string, ActualTransaction>();
  const add = (tx: ActualTransaction | null): void => {
    if (tx && !seen.has(tx.id)) seen.set(tx.id, tx);
  };
  for (const reason of row.reasons) {
    if (reason.kind === 'already-imported') reason.matched.forEach(add);
    if (reason.kind === 'inside-reconciled-range') add(reason.matched);
    if (reason.kind === 'same-amount-within-one-day') reason.candidates.forEach(add);
  }
  return [...seen.values()];
}

/** What makes a match matter to a write: a split, a reconciled transaction. */
function flags(tx: ActualTransaction): string[] {
  return [...(tx.is_parent ? ['split'] : []), ...(tx.reconciled ? ['reconciled'] : [])];
}

/** The Tape's `match` column: on what basis the row matched, in a few words. */
export function matchTag(row: ClassifiedRow, numberOf: NumberOf): string {
  const tags = row.reasons.flatMap((reason) => {
    switch (reason.kind) {
      case 'already-imported':
        return [
          `imported ID${reason.matched.length > 1 ? ` ×${reason.matched.length}` : ''}`,
        ];
      case 'same-amount-within-one-day': {
        const { candidates } = reason;
        const day = candidates.some((tx) => tx.date !== row.source.date)
          ? '±1 day'
          : 'same day';
        const [only] = candidates;
        if (candidates.length === 1 && only !== undefined)
          return [[...flags(only), day].join(', ')];
        return [`${candidates.length} matches, ${day}`];
      }
      case 'repeated-in-this-file':
        return [`same as ${rowRef(reason.firstSeenLine, numberOf)}`];
      // The bucket already says Locked, and its match is the blind duplicate's.
      case 'inside-reconciled-range':
      case 'no-match':
        return [];
    }
  });
  return tags.join(' · ');
}
/**
 * The Tape's column widths, single-sourced.
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
  bucket: 10,
} as const;

/**
 * The payee takes what the terminal has to spare once the last column - the
 * match, or a block's tags - has its room, between these two. The tags come
 * first: a cut payee is still recognisable, a cut "reconciled" is not.
 */
const PAYEE = { min: 12, max: 40 } as const;

/** The most room the match column asks for; past that a tag is cut. */
const MATCH_ROOM = 20;

const TAPE_INDENT =
  COLUMN.index + 1 + COLUMN.date + 1 + COLUMN.amount + 1 + COLUMN.bucket + 1;

/** How wide the payee is, with `indent` columns before it and `tagRoom` after. */
function payeeWidth(style: TapeStyle, indent: number, tagRoom: number): number {
  const spare = style.width - indent - (tagRoom === 0 ? 0 : tagRoom + 1);
  return Math.min(PAYEE.max, Math.max(PAYEE.min, spare));
}

function columns(
  style: TapeStyle,
  matchRoom: number,
  cells: {
    index: string;
    date: string;
    amount: string;
    bucket: Segment;
    payee: string;
    match: Segment;
  },
): Segment[] {
  const payee = payeeWidth(style, TAPE_INDENT, matchRoom);
  return [
    {
      text: `${cells.index.padStart(COLUMN.index)} ${cells.date.padEnd(COLUMN.date)} `,
    },
    { text: `${cells.amount.padStart(COLUMN.amount)} ` },
    { ...cells.bucket, text: cells.bucket.text.padEnd(COLUMN.bucket) },
    { text: ' ' },
    // The payee is cut to its column rather than pushing the match column out.
    { text: `${clip(cells.payee, payee).padEnd(payee)} ` },
    cells.match,
  ];
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

export function tapeHeader(style: TapeStyle, matchRoom = MATCH_ROOM): string {
  return fit(
    columns(style, matchRoom, {
      index: '#',
      date: 'date',
      amount: 'amount',
      bucket: { text: 'bucket' },
      payee: 'payee',
      // No row has a match, so there is no column to name.
      match: { text: matchRoom === 0 ? '' : 'match' },
    }),
    style.width,
    style,
  );
}

/** The Tape's own line for one classified row. */
export function tapeLine(
  index: number,
  row: ClassifiedRow,
  style: TapeStyle,
  numberOf: NumberOf,
  /** The same for every row of one Tape, so that its columns line up. */
  matchRoom = MATCH_ROOM,
): string {
  const { source, bucket } = row;
  return fit(
    columns(style, matchRoom, {
      index: String(index),
      date: source.date,
      amount: formatCents(source.amountCents, COLUMN.amount),
      bucket: { text: bucket, code: STYLE[bucket] },
      payee: source.payee,
      match: { text: matchTag(row, numberOf), code: DIM },
    }),
    style.width,
    style,
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What is printed before the first prompt: the batch at a glance. */
export function overview(
  batch: {
    accountName: string;
    rows: readonly ClassifiedRow[];
    boundary: string | null;
    dropped: readonly DroppedRow[];
  },
  style: TapeStyle,
): string[] {
  const { accountName, rows, boundary, dropped } = batch;
  const counts = tally(rows);
  const numberOf = numbering(rows);
  const line = (text: string): string => fit([{ text }], style.width, style);
  const lines = [
    line(
      `${accountName}: ${plural(rows.length, 'transaction', 'transactions')} · ` +
        (boundary === null
          ? 'nothing reconciled yet'
          : `reconciled through ${boundary}`),
    ),
    line(
      `  ${counts.clean} clean · ${counts.suspicious} suspicious · ` +
        `${counts.skip} skip · ${counts.locked} locked`,
    ),
  ];
  if (dropped.length > 0) {
    lines.push(
      line(
        dropped.length === 1
          ? '  1 row in the file was not read as a transaction:'
          : `  ${dropped.length} rows in the file were not read as transactions:`,
      ),
    );
    for (const row of dropped)
      lines.push(line(`    line ${row.sourceLine}: ${row.reason}`));
  }
  const matchRoom = Math.min(
    MATCH_ROOM,
    Math.max(0, ...rows.map((row) => matchTag(row, numberOf).length)),
  );
  lines.push('', tapeHeader(style, matchRoom));
  for (const [index, row] of rows.entries()) {
    lines.push(tapeLine(index + 1, row, style, numberOf, matchRoom));
  }
  return lines;
}

/** The block's columns: label, date, amount, payee, tags. */
const LABEL = 8;
const SIDE_INDENT = 2 + LABEL + 1 + COLUMN.date + 1 + COLUMN.amount + 2;

/** One version of a transaction in a block: the bank's, or one in Actual. */
type Side = {
  label: string;
  tx: { date: string; amount: number; payee: string; notes: string };
  tags: readonly string[];
};

function sideBySide(side: Side, payee: number, style: TapeStyle): string[] {
  const { label, tx } = side;
  const tags = side.tags.join(', ');
  // Tags that would be cut beside the payee go on a line of their own: they
  // are what says a write would touch a split or a reconciled transaction.
  const inline = SIDE_INDENT + payee + 1 + tags.length <= style.width;
  const lines = [
    fit(
      [
        {
          text:
            `  ${label.padEnd(LABEL)} ${tx.date.padEnd(COLUMN.date)} ` +
            `${formatCents(tx.amount, COLUMN.amount)}  `,
        },
        { text: `${clip(tx.payee, payee).padEnd(payee)} ` },
        { text: inline ? tags : '', code: WARN },
      ],
      style.width,
      style,
    ),
  ];
  if (!inline) {
    lines.push(
      fit(
        [{ text: ' '.repeat(SIDE_INDENT) }, { text: tags, code: WARN }],
        style.width,
        style,
      ),
    );
  }
  if (tx.notes !== '') {
    lines.push(
      fit(
        [{ text: ' '.repeat(SIDE_INDENT) }, { text: tx.notes, code: DIM }],
        style.width,
        style,
      ),
    );
  }
  return lines;
}

/** Stored transactions holding the row's imported ID. */
function heldByImportedId(row: ClassifiedRow): Set<string> {
  return new Set(
    row.reasons.flatMap((r) =>
      r.kind === 'already-imported' ? r.matched.map((tx) => tx.id) : [],
    ),
  );
}

/**
 * Each match with its label. When more than one can still be corrected they are
 * numbered, and those numbers are what the which-one prompt offers.
 */
function labelledMatches(
  row: ClassifiedRow,
  corrected: ReadonlySet<string>,
): { label: string; tx: ActualTransaction }[] {
  const all = matches(row);
  const open = all.filter((tx) => !corrected.has(tx.id));
  return all.map((tx) => {
    const choice = open.indexOf(tx);
    return {
      label: choice >= 0 && open.length > 1 ? `actual ${choice + 1}` : 'actual',
      tx,
    };
  });
}

export type ReviewedRow = {
  number: number;
  total: number;
  row: ClassifiedRow;
  /** Stored transactions an earlier row in this run already corrected. */
  corrected: ReadonlySet<string>;
  /** Short, one line each; `[?]` has the long form. */
  warnings: readonly string[];
};

/**
 * One reviewed row: the bank's version, then each stored transaction it
 * matched, named once and lined up under it, then what to watch out for.
 *
 * Matches are labelled as `labelledMatches` says. A match an earlier row already
 * corrected stays visible, unnumbered, so the row does not look as if it never
 * matched anything.
 */
export function block(
  reviewed: ReviewedRow,
  style: TapeStyle,
  numberOf: NumberOf,
): string[] {
  const { number, total, row, corrected } = reviewed;
  const { source, bucket } = row;

  const title = `── ${number} of ${total} · ${bucket} `;
  const rule = title + '─'.repeat(Math.max(0, style.width - title.length));

  const sides: Side[] = [
    {
      label: 'bank',
      tx: {
        date: source.date,
        amount: source.amountCents,
        payee: source.payee,
        notes: source.notes,
      },
      tags: row.reasons.flatMap((r) =>
        r.kind === 'repeated-in-this-file'
          ? [`same as ${rowRef(r.firstSeenLine, numberOf)}`]
          : [],
      ),
    },
  ];
  const byImportedId = heldByImportedId(row);
  for (const { label, tx } of labelledMatches(row, corrected)) {
    sides.push({
      label,
      tx: {
        date: tx.date,
        amount: tx.amount,
        payee: tx.payeeName ?? '',
        notes: tx.notes ?? '',
      },
      tags: [
        ...(byImportedId.has(tx.id) ? ['imported ID'] : []),
        ...flags(tx),
        ...(corrected.has(tx.id) ? ['corrected above'] : []),
      ],
    });
  }

  // One payee width for the whole block, so its tags line up.
  const payee = payeeWidth(
    style,
    SIDE_INDENT,
    Math.max(...sides.map((side) => side.tags.join(', ').length)),
  );
  const lines = [fit([{ text: rule, code: STYLE[bucket] }], style.width, style)];
  for (const side of sides) lines.push(...sideBySide(side, payee, style));
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

const KEY = 13;
const DETAIL_INDENT = 2 + LABEL + 1;

const ORIGIN: Record<SourceTransaction['importedIdOrigin'], string> = {
  'bank-reference': "the bank's reference",
  minted: 'minted from the row, as this format carries no reference',
  absent: 'none: the bank wrote no reference',
};

/**
 * What `[?]` shows: why the row is in its bucket, then every field of the
 * bank's version and of each match, uncut. Laid out like the block, under the
 * same labels, and wrapped to the terminal rather than cut.
 */
export function detail(
  reviewed: Pick<ReviewedRow, 'row' | 'corrected'>,
  style: TapeStyle,
  numberOf: NumberOf,
): string[] {
  const { row, corrected } = reviewed;
  const { source } = row;
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
    explain(row.reasons, numberOf).map((why) => ['', why] as const),
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
  for (const { label, tx } of labelledMatches(row, corrected)) {
    const parts = tx.subtransactions ?? [];
    section(label, [
      ['payee', tx.payeeName ?? ''],
      ['notes', tx.notes ?? ''],
      ['imported ID', tx.imported_id ?? 'none'],
      ...(parts.length > 0
        ? [
            [
              'split into',
              parts.map((p) => formatCents(p.amount).trim()).join(', '),
            ] as const,
          ]
        : []),
      ...(tx.reconciled ? [['reconciled', 'yes'] as const] : []),
      ...(corrected.has(tx.id)
        ? [['', 'corrected by an earlier row in this run'] as const]
        : []),
    ]);
  }
  return lines;
}
