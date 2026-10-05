/** Where a source transaction's imported ID came from. */
export type ImportedIdOrigin =
  /** The bank wrote a reference and we use it verbatim. */
  | 'bank-reference'
  /** The format never carries one, so we minted it deterministically. */
  | 'minted'
  /** The format normally carries one and this row did not. Stays blank. */
  | 'absent';

/**
 * A transaction parsed from a bank statement file: the raw input the
 * classifier decides what to do with.
 */
export type SourceTransaction = {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Signed integer cents, Actual's convention: negative is an outflow. */
  amountCents: number;
  payee: string;
  notes: string;
  /** Blank when the format normally carries a reference and this row had none. */
  importedId: string;
  importedIdOrigin: ImportedIdOrigin;
  /** 1-based line number in the source file, for the Tape and for evidence. */
  sourceLine: number;
  /** Set when the bank has authorised it but not booked it yet. */
  pending?: Pending;
};

/**
 * A pending statement transaction's amount is not final: it is the purchase's
 * original amount, in its original currency, until the bank books it.
 */
export type Pending = {
  /** The currency its amount is stated in, e.g. `USD`. */
  originalCurrency: string;
  /** The account's own currency, e.g. `CHF`: what the amount is written as. */
  accountCurrency: string;
};

/** The dates a statement covers, both included. ISO `YYYY-MM-DD`. */
export type Period = { from: string; to: string };

/** A source row the parser did not turn into a transaction, and why. */
export type DroppedRow = {
  sourceLine: number;
  reason: string;
  raw: string;
};

/** Everything one statement file yields. */
export type ParsedStatement = {
  /** The parser that read it, e.g. `ubs-account-csv`. */
  format: string;
  /** The identifier the file carries: an IBAN, or a card number. */
  accountKey: string;
  /**
   * The period the file says it covers, or null when it says none, as the
   * cards CSV does. It can reach past the first and last transaction.
   */
  period: Period | null;
  transactions: SourceTransaction[];
  /**
   * Rows deliberately not imported — today the cards CSV's per-currency
   * footer, and any row whose date or amount cannot be read. Carried rather
   * than logged so the Tape can say the file held more than it proposes.
   */
  dropped: DroppedRow[];
};

/** A statement parser: claims a file, then reads it. */
export type StatementParser = {
  format: string;
  canParse(path: string): boolean;
  parse(path: string): ParsedStatement;
};
