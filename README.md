# Cetus DLMM Automated Market Making Strategy

This is an automated market making strategy based on Cetus DLMM SDK, providing market making within a price range for the USDT/USDC stablecoin pair.

## Strategy Principle

The strategy provides market making within the price range [0.9995, 1.0005]:

1. **Initial State**: Holding USDT
2. **Place Order at 1.0005**: Place USDT in the 1.0005 bin
3. **Price Exceeds 1.0005**: Sell USDT to get USDC
4. **Place Order at 0.9995**: Place USDC in the 0.9995 bin
5. **Price Below 0.9995**: Sell USDC to get USDT
6. **Repeat Cycle**: Continuously provide market making within the price range

## Installation

```bash
# Using Bun
bun install

# Or using npm
npm install
```

## Quick Start

### 1. Import Strategy

```typescript
import { AMMStrategy } from './amm-strategy';
import { mainnetConfig } from './config';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
```

### 2. Configure Strategy

```typescript
// Use default configuration
const config = mainnetConfig;

// Or create custom configuration
const customConfig = createCustomConfig(
  '1.0005', // Upper price limit
  '0.9995', // Lower price limit
  '1000000', // Position size (1 USDT/USDC)
  '0xYourWalletAddress', // Sender address
  'mainnet' // Network
);
```

### 3. Start Strategy

```typescript
const strategy = new AMMStrategy(config, keypair);

// Start strategy
await strategy.start();

// Get strategy status
const status = strategy.getStatus();
console.log('Strategy status:', status);

// Stop strategy
// strategy.stop();
```

### 4. Run Strategy

```bash
# Run with Bun
bun run run-strategy.ts

# Or use development mode (auto-restart on file changes)
bun --watch run-strategy.ts

# Using environment variables
bun run run-strategy.ts
```

## Configuration

### Core Parameters

- `upperPrice`: Upper price limit (1.0005)
- `lowerPrice`: Lower price limit (0.9995)
- `positionSize`: Amount per operation
- `binStep`: Bin step size (recommended 1-5 bps)
- `checkInterval`: Price check interval (milliseconds)
- `slippage`: Slippage protection (0.001 = 0.1%)

### Token Configuration

- `tokenA`: USDT token address
- `tokenB`: USDC token address

### Network Configuration

- `network`: 'mainnet' or 'testnet'
- `senderAddress`: Wallet address

## Strategy Advantages

1. **Automation**: Automatically monitors prices and executes trades
2. **Range Market Making**: Provides market making within narrow range for stablecoin pairs
3. **Risk Management**: Clear entry and exit conditions
4. **Fee Optimization**: Executes trades only when price breaks through

## Risk Warnings

1. **Impermanent Loss**: Potential losses during significant price fluctuations
2. **Transaction Fees**: Transaction costs for each operation
3. **Network Latency**: Time required for transaction execution
4. **Liquidity Risk**: Market depth may affect execution

## Development Notes

### Extension Features

1. **Price Source Integration**: Integrate multiple price sources for better accuracy
2. **Position Management**: Dynamically adjust position size based on market volatility
3. **Risk Control**: Add stop-loss and maximum loss limits
4. **Data Analysis**: Record transaction history and profit statistics

### Testing Recommendations

1. **Test on Testnet**: Verify strategy logic on testnet first
2. **Small Capital Testing**: Use small amounts for live testing
3. **Monitor Logs**: Closely monitor strategy execution logs
4. **Performance Optimization**: Optimize parameters based on actual operation

## Technical Support

For issues, please refer to:
- [Cetus DLMM SDK Documentation](https://docs.cetus.zone/)
- [Sui TypeScript SDK Documentation](https://sui-typescript-docs.vercel.app/)
- [Sui Official Documentation](https://docs.sui.io/)