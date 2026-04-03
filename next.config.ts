import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      util: 'util/',
    },
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = Array.isArray(config.externals)
        ? config.externals
        : config.externals
        ? [config.externals]
        : []

      config.externals.push('pino-pretty', 'lokijs', 'encoding', 'porto')
    }

    config.resolve = config.resolve || {}
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      util: require.resolve('util/'),
    }

    return config
  }
};

export default nextConfig;
