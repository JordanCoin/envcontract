/**
 * Bundle entry for the `envcontract` binary. `cli.ts` stays side-effect free so
 * the test suite can import it; this file is the one that actually runs it.
 */

import { cliMain } from "./cli.js";

void cliMain();
