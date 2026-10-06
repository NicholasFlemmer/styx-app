import { createMDX } from 'fumadocs-mdx/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: false,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
};

// The docs (heystyx.com/docs): MDX under content/docs, compiled by Fumadocs MDX (source.config.ts).
const withMDX = createMDX();

export default withMDX(nextConfig);
