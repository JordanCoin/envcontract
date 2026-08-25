// Next.js app-router page. Client-visible config only.
export const runtime = "nodejs";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
const analyticsId = process.env.NEXT_PUBLIC_ANALYTICS_ID ?? "";

export default function Page() {
  // NODE_ENV is a platform built-in: it must never reach a finding.
  const banner = process.env.NODE_ENV === "production" ? "live" : "staging";

  return (
    <main data-analytics={analyticsId}>
      <a href={siteUrl}>{banner}</a>
    </main>
  );
}
