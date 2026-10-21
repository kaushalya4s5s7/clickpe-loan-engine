import type { NextConfig } from "next";

// Static export: the console is plain files on S3 + CloudFront. It talks to API Gateway from the
// browser, so there is no Next.js server to run, patch or pay for.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true, // /upload/ → upload/index.html, which a plain S3 origin can serve
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
