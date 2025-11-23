import type { StrategyConfig } from './amm-strategy';

// Default configuration
const defaultConfig: StrategyConfig = {
  // Price range
  upperPrice: '1.0005', // Upper price limit
  lowerPrice: '0.9995', // Lower price limit

  // Token configuration
  tokenA: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', // USDC
  tokenB: '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT', // USDT

  // Position configuration
  positionSize: '1000000', // 1 USDT/USDC (6 decimals)
  binStep: 1, // 1 bps (0.01%)

  // Network configuration
  network: 'mainnet',
  senderAddress: '0xYourWalletAddress',

  // Pool configuration
  poolId: '0xca0037224bc74b92d8a6ef1c6118a33232e65df22cb06809025f275f265b3d55',

  // Monitoring configuration
  checkInterval: 10000, // Check every 10 seconds
  slippage: 0.001, // 0.1% slippage
};

// Mainnet configuration
export const mainnetConfig: StrategyConfig = {
  ...defaultConfig,
  network: 'mainnet',
  tokenA: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', // USDC
  tokenB: '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT', // USDT
};


// Custom configuration
export function createCustomConfig(
  upperPrice: string,
  lowerPrice: string,
  positionSize: string,
  senderAddress: string,
  network: 'mainnet' = 'mainnet'
): StrategyConfig {
  return {
    ...defaultConfig,
    upperPrice,
    lowerPrice,
    positionSize,
    senderAddress,
    network,
  };
}