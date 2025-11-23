import { AMMStrategy } from './amm-strategy.js';
import { mainnetConfig } from './config.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

/**
 * Run automated market making strategy
 */
async function runStrategy() {
  console.log('🚀 Starting Cetus DLMM automated market making strategy...\n');

  // Create keypair
  // Note: In production, load private key from secure storage
  const mnemonics: string = process.env.MNEMONICS!;
  const i = 0;
  const path = `m/44'/784'/${i}'/0'/0'`;
  let keypair: Ed25519Keypair;

  if (mnemonics) {
    console.log('🔑 Loading private key from environment variables...');
    keypair = Ed25519Keypair.deriveKeypair(mnemonics, path);
  } else {
    console.log('⚠️  No private key found, generating new test keypair...');
    keypair = new Ed25519Keypair();
    console.log(`📝 New address: ${keypair.toSuiAddress()}`);
    console.log('⚠️  Please ensure this address has sufficient test tokens!');
  }

  // Configure strategy parameters
  const config = {
    ...mainnetConfig,
    // Use address generated from mnemonic
    senderAddress: keypair.toSuiAddress(),
    positionSize: '1000000', // 1 USDT/USDC
    checkInterval: 15000, // Check every 15 seconds
  };

  // Create strategy instance
  const strategy = new AMMStrategy(config, keypair);

  // Setup graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Received stop signal, stopping strategy...');
    strategy.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n🛑 Received termination signal, stopping strategy...');
    strategy.stop();
    process.exit(0);
  });

  try {
    // Start strategy
    await strategy.start();
  } catch (error) {
    console.error('❌ Strategy startup failed:', error);
    process.exit(1);
  }
}

// Run strategy
runStrategy().catch(console.error);