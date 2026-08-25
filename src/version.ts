/**
 * The version reported in the User-Agent and in every report body.
 *
 * It is a compile-time constant on purpose: the bundled action reads no files at
 * startup, so there is no `package.json` to consult at runtime. `package.json`
 * stays the source of truth — `tests/invariants.test.ts` fails the build if the
 * two ever drift apart, so bumping one means bumping the other.
 */
export const VERSION = "1.0.0";

/** The User-Agent sent on every Vercel request: `envcontract/<version>`. */
export const USER_AGENT = `envcontract/${VERSION}`;
