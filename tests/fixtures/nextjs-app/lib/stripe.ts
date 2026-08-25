// `!` is a non-null assertion, not a default: the key stays required.
const secretKey = process.env.STRIPE_SECRET_KEY!;

export function stripe() {
  return { secretKey };
}
