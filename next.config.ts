import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone server bundle for the Docker image (deploy is a later step,
  // but the option costs nothing now and avoids a surprise then)
  output: "standalone",
};

export default nextConfig;
