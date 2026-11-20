/** @type {import('next').NextConfig} */
const nextConfig = {
  // Scaffold: no rewrites/proxies yet. The web app talks to apps/api directly
  // via NEXT_PUBLIC_API_URL (see .env.example). API wiring lands after the
  // auth provider is selected (ADR-011).
  reactStrictMode: true,
};

export default nextConfig;
