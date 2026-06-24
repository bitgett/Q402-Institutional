import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the file-tracing root to THIS project. Without this, Next walks up
  // looking for the nearest lockfile and sometimes lands on a stray
  // package-lock.json in the parent directory (e.g. C:\Users\user\), which
  // makes serverless deploy traces bundle unrelated files. Explicit > inferred.
  outputFileTracingRoot: __dirname,
  // Ship the OG card's Poppins TTFs with the route in case it is served
  // dynamically (the fs.readFile in app/opengraph-image.tsx is not auto-traced).
  outputFileTracingIncludes: {
    "/opengraph-image": ["./app/_fonts/**"],
  },
  // Clean URL for the standalone Vision page (static file in /public).
  async rewrites() {
    return [{ source: "/vision", destination: "/vision.html" }];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/api/relay/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
        ],
      },
    ];
  },
};

export default nextConfig;
