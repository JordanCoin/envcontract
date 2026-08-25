const apiUrl = import.meta.env.VITE_API_URL;
const sentryDsn = import.meta.env.VITE_SENTRY_DSN ?? "";

// MODE is a Vite built-in on import.meta.env: it must never reach a finding.
if (import.meta.env.MODE === "development") {
  globalThis.reportError?.(new Error(`booting ${apiUrl}`));
}

export { apiUrl, sentryDsn };
