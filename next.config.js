/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vercel + Next API routes: keep it simple & stable
  reactStrictMode: true,

  // We use ES modules ("type": "module" in package.json)
  // so Next will handle ESM fine.

  // Allow remote images (CoinGecko icons) in the web UI
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "assets.coingecko.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "coin-images.coingecko.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "static.coingecko.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "images.coingecko.com",
        pathname: "/**",
      },
    ],
  },

  // Avoid build failures on Vercel due to optional linting
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Same for TS if you later add TS incrementally
  typescript: {
    ignoreBuildErrors: true,
  },

  // Security headers for pages + API
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;