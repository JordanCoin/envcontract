// `new URL(...)` consumes the value directly: the key stays required.
export const analytics = new URL(import.meta.env.VITE_ANALYTICS_URL);
