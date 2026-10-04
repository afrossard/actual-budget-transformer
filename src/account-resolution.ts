/**
 * Which Actual account a statement goes into - and, when there is none, a
 * message that says which of the two fixes applies.
 *
 * The match is exact, case-sensitive and against open accounts only, and stays
 * that way: picking the wrong account would write a statement into someone
 * else's history. Near matches appear in the message as suggestions, never as
 * a substitution.
 *
 * The message is the whole surface (#65). It is the only thing on screen at
 * the moment this fails, which is the first thing a real user hits when
 * pointing the tool at a real budget.
 */
import { configKey, type AccountTarget } from './config.ts';
import type { Account } from './actual-gateway.ts';

/** Enough to choose from, few enough to read. */
const LISTED_ACCOUNTS = 20;

/** Case-insensitive but accent-sensitive: "Épargne" is not a typo of "Epargne". */
const caseless = new Intl.Collator(undefined, { sensitivity: 'accent' });
/** The listing's order: what a person scanning it expects, case aside. */
const alphabetical = new Intl.Collator(undefined, { sensitivity: 'base' });

export function resolveAccount(
  target: AccountTarget,
  accounts: readonly Account[],
): Account {
  const open = accounts.filter((a) => !a.closed);
  const match = open.find((a) => a.name === target.name);
  if (match) return match;
  throw new Error(explain(target, accounts, open));
}

function explain(
  target: AccountTarget,
  accounts: readonly Account[],
  open: readonly Account[],
): string {
  const lines: string[] = [];
  if (!target.mapped) {
    lines.push(
      `${target.accountKey} is not in account_names. Add this entry to that block in your config:`,
      // Indented as config.template.yml indents it, so it pastes as it stands.
      '',
      `  ${JSON.stringify(configKey(target.accountKey))}: "<the account's name in Actual>"`,
      '',
    );
  } else if (accounts.some((a) => a.closed && a.name === target.name)) {
    lines.push(
      `account_names maps ${target.accountKey} to ${JSON.stringify(target.name)}, ` +
        'which exists in the budget but is closed.',
      '  Reopen it in Actual, or map the identifier to an open account.',
    );
  } else {
    lines.push(
      `account_names maps ${target.accountKey} to ${JSON.stringify(target.name)}, ` +
        'but the budget has no open account with that name.',
    );
    const near = open.filter(
      (a) => caseless.compare(squash(a.name), squash(target.name)) === 0,
    );
    if (near.length > 0) {
      lines.push(
        `  Did you mean ${near.map((a) => JSON.stringify(a.name)).join(' or ')}?`,
      );
    }
  }
  lines.push(...listing(open));
  return lines.join('\n');
}

/** Trimmed, with inner runs of whitespace collapsed: for suggestions only. */
function squash(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function listing(open: readonly Account[]): string[] {
  if (open.length === 0) return ['  The budget has no open accounts.'];
  const names = open.map((a) => a.name).sort(alphabetical.compare);
  const shown = names
    .slice(0, LISTED_ACCOUNTS)
    .map((name) => `    ${JSON.stringify(name)}`);
  const rest = names.length - LISTED_ACCOUNTS;
  return [
    `  Open accounts in the budget (${names.length}):`,
    ...shown,
    ...(rest > 0 ? [`    … and ${rest} more`] : []),
  ];
}
