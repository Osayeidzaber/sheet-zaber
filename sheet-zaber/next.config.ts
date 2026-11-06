import type { NextConfig } from "next"

const isDev = process.env.NODE_ENV === "development"

/*
 * Content Security Policy. Scripts/styles are first-party (plus the inline bootstraps
 * Next emits); images additionally allow Google avatar CDN (lh3.googleusercontent.com)
 * for user profile pictures.
 */
const csp = [
  "default-src 'self'",
  // apis.google.com and docs.google.com are for the Google Picker on the spreadsheets page.
  `script-src 'self' 'unsafe-inline' https://apis.google.com${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com https:",
  `connect-src 'self' https://www.googleapis.com${isDev ? " ws: wss:" : ""}`,
  "frame-src https://docs.google.com https://drive.google.com https://content.googleapis.com",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ")

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
]

const nextConfig: NextConfig = {
  // cacheComponents stays OFF for this app (plan.md D3): the dashboard is dynamic
  // (cookies/auth per request) and gains nothing from the cache components model.
  poweredByHeader: false,
  reactStrictMode: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }]
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
}

export default nextConfig
