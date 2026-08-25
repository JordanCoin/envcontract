/**
 * Private character helpers shared by the scanner. Not part of the public
 * scanner surface: everything here operates on offsets into a source string.
 */

const CH_TAB = 9;
const CH_LF = 10;
const CH_VT = 11;
const CH_FF = 12;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_DOLLAR = 36;
const CH_UNDERSCORE = 95;
const CH_NBSP = 0xa0;
const CH_LSEP = 0x2028;
const CH_PSEP = 0x2029;
const CH_IDEOGRAPHIC_SPACE = 0x3000;
const CH_BOM = 0xfeff;

export function isWs(code: number): boolean {
  return (
    code === CH_SPACE ||
    code === CH_TAB ||
    code === CH_LF ||
    code === CH_CR ||
    code === CH_VT ||
    code === CH_FF ||
    code === CH_NBSP ||
    code === CH_LSEP ||
    code === CH_PSEP ||
    code === CH_IDEOGRAPHIC_SPACE ||
    code === CH_BOM
  );
}

/** JS identifier character, approximated: ASCII word chars, `$`, and any non-space above ASCII. */
export function isIdentChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === CH_UNDERSCORE ||
    code === CH_DOLLAR ||
    (code > 127 && !isWs(code))
  );
}

/** First offset at or after `from` that is not whitespace. */
export function skipWs(text: string, from: number): number {
  let i = from;
  while (i < text.length && isWs(text.charCodeAt(i))) i += 1;
  return i;
}

/** Last offset at or before `from` that is not whitespace, or -1. */
export function skipWsBack(text: string, from: number): number {
  let i = from;
  while (i >= 0 && isWs(text.charCodeAt(i))) i -= 1;
  return i;
}

/** The identifier starting at `from`, or "" when `from` is not an identifier start. */
export function readIdent(text: string, from: number): string {
  let i = from;
  while (i < text.length && isIdentChar(text.charCodeAt(i))) i += 1;
  return text.slice(from, i);
}

/** The identifier ENDING at `from` (inclusive), or "" when there is none. */
export function readIdentBack(text: string, from: number): string {
  if (from < 0 || !isIdentChar(text.charCodeAt(from))) return "";
  let i = from;
  while (i >= 0 && isIdentChar(text.charCodeAt(i))) i -= 1;
  return text.slice(i + 1, from + 1);
}
