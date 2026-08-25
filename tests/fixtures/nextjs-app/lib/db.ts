// `new URL(...)` consumes the value directly: the key stays required.
export const connection = new URL(process.env.DATABASE_URL);

export function describeConnection() {
  return connection.host;
}
