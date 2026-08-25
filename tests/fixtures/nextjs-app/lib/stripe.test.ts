// A test file. Only scanned when `include_tests` is on.
import { stripe } from "./stripe.js";

export function checkSandboxKey() {
  const sandboxKey = process.env.STRIPE_TEST_ONLY_KEY!;
  return sandboxKey !== stripe().secretKey;
}
