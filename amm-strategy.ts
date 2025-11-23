import { CetusDlmmSDK, StrategyType, BinUtils, parseLiquidityShares } from '@cetusprotocol/dlmm-sdk';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import BN from 'bn.js';

export interface StrategyConfig {
  // Price range (USDC/USDT)
  upperPrice: string; // Upper price limit, e.g., 1.0005
  lowerPrice: string; // Lower price limit, e.g., 0.9995

  // Token configuration
  tokenA: string; // USDC
  tokenB: string; // USDT

  // Position configuration
  positionSize: string; // Amount per operation (used when removing liquidity)
  binStep: number; // Bin step size

  // Network configuration
  network: 'mainnet';
  senderAddress: string;

  // Pool configuration
  poolId?: string; // Specific pool ID, if provided use directly

  // Monitoring configuration
  checkInterval: number; // Check interval (milliseconds)
  slippage: number; // Slippage protection

}

interface PositionState {
  currentToken: 'USDT' | 'USDC'; // Currently held token
  currentPositionId?: string;
  currentBinId?: number;
  lastActionTime: number;
  totalProfit: string;
  currentBalance?: {
    usdc: string;
    usdt: string;
  };
}

export class AMMStrategy {
  private sdk: CetusDlmmSDK;
  private client: SuiClient;
  private keypair: Ed25519Keypair;
  private config: StrategyConfig;
  private state: PositionState;
  private isRunning: boolean = false;
  private poolAddress?: string;

  constructor(config: StrategyConfig, keypair: Ed25519Keypair) {
    this.config = config;
    this.keypair = keypair;

    // Initialize Sui client
    this.client = new SuiClient({
      url: 'https://sui-mainnet.nodeinfra.com'
    });

    // Initialize SDK
    this.sdk = CetusDlmmSDK.createSDK({
      env: config.network,
      sui_client: this.client,
    });
    this.sdk.setSenderAddress(this.keypair.toSuiAddress());

    // Initialize state
    this.state = {
      currentToken: 'USDT', // Initially hold USDT
      lastActionTime: Date.now(),
      totalProfit: '0'
    };
  }

  /**
   * Start strategy
   */
  async start(): Promise<void> {
    this.isRunning = true;
    console.log('🚀 Starting automated market making strategy...');
    console.log(`📊 Price calculation: ${this.config.tokenA.includes('usdc') ? 'USDC' : 'tokenA'} / ${this.config.tokenB.includes('usdt') ? 'USDT' : 'tokenB'}`);
    console.log(`🎯 Price range: ${this.config.lowerPrice} - ${this.config.upperPrice}`);

    // Get pool address
    await this.initializePool();

    // Detect balance and select initial token
    await this.detectInitialToken();

    // Check existing positions
    const existingPositions = await this.getExistingPositions();
    if (existingPositions.length > 0) {
      console.log(`📋 Found ${existingPositions.length} existing positions, using first position`);
      this.state.currentPositionId = existingPositions[0];

      // Try to get position information to determine current state
      try {
        const position = await this.sdk.Position.getPosition(existingPositions[0]);
        // Can infer current state from position information
        // Keep default state for now, can optimize later
        console.log(`📊 Existing position info: bin ${position.lower_bin_id} - ${position.upper_bin_id}`);
      } catch (error) {
        console.warn('⚠️ Unable to get detailed position information, using default state');
      }
    }

    // Start monitoring loop
    await this.monitoringLoop();
  }

  /**
   * Stop strategy
   */
  stop(): void {
    this.isRunning = false;
    console.log('🛑 Stopping automated market making strategy');
  }

  /**
   * Initialize pool information
   */
  private async initializePool(): Promise<void> {
    try {
      // If pool ID is provided, use it directly
      if (this.config.poolId) {
        this.poolAddress = this.config.poolId;
        console.log(`✅ Using specified pool address: ${this.poolAddress}`);
      } else {
        // Otherwise dynamically get pool address
        this.poolAddress = await this.sdk.Pool.getPoolAddress(
          this.config.tokenA,
          this.config.tokenB,
          this.config.binStep,
          10000 // baseFactor for stable pairs
        );
        console.log(`✅ Dynamically obtained pool address: ${this.poolAddress}`);
      }
    } catch (error) {
      console.error('❌ Failed to initialize pool:', error);
      throw error;
    }
  }

  /**
   * Monitoring loop
   */
  private async monitoringLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.checkAndExecuteStrategy();
        await this.delay(this.config.checkInterval);
      } catch (error) {
        console.error('❌ Monitoring loop error:', error);
        await this.delay(5000); // Wait 5 seconds on error
      }
    }
  }

  /**
   * Check and execute strategy
   *
   * Strategy logic:
   * - Price = USDC / USDT
   * - When price > 1, USDC appreciates relative to USDT
   * - When price < 1, USDC depreciates relative to USDT
   *
   * Correct strategy:
   * - When holding USDT, buy USDC when price is below lower limit (USDC is cheap)
   * - When holding USDC, buy USDT when price exceeds upper limit (USDT is cheap)
   */
  private async checkAndExecuteStrategy(): Promise<void> {
    const currentPrice = await this.getCurrentPrice();
    console.log(`📊 Current price: ${currentPrice} (USDC/USDT)`);

    if (this.state.currentToken === 'USDT') {
      // Currently holding USDT, check if price is below lower limit
      // When price < lower limit, USDC depreciates relative to USDT, should buy USDC
      if (parseFloat(currentPrice) <= parseFloat(this.config.lowerPrice)) {
        console.log(`📉 Price below lower limit ${this.config.lowerPrice}, buying USDC (selling USDT)`);
        await this.executeBuyUSDC();
      }
    } else {
      // Currently holding USDC, check if price exceeds upper limit
      // When price > upper limit, USDC appreciates relative to USDT, should buy USDT
      if (parseFloat(currentPrice) >= parseFloat(this.config.upperPrice)) {
        console.log(`📈 Price exceeds upper limit ${this.config.upperPrice}, buying USDT (selling USDC)`);
        await this.executeBuyUSDT();
      }
    }
  }

  /**
   * Get current price (USDC/USDT)
   */
  private async getCurrentPrice(): Promise<string> {
    try {
      if (!this.poolAddress) {
        throw new Error('Pool address not initialized');
      }

      // Get pool information
      const pool = await this.sdk.Pool.getPool(this.poolAddress);

      // Calculate actual price from active bin id
      const decimalA = 6; // USDC precision
      const decimalB = 6; // USDT precision

      const price = BinUtils.getPriceFromBinId(
        pool.active_id,
        pool.bin_step,
        decimalA,
        decimalB
      );

      // Format price (convert from internal format to standard format)
      const formattedPrice = (parseFloat(price) * 1000000).toFixed(6);
      return formattedPrice;

    } catch (error) {
      console.error('❌ Failed to get price:', error);
      return '1.0000'; // Default price
    }
  }

  /**
   * Execute buy USDC operation (sell USDT)
   */
  private async executeBuyUSDC(): Promise<void> {
    try {
      // 1. Collect accumulated fees and rewards
      if (this.state.currentPositionId) {
        await this.collectFeesAndRewards(this.state.currentPositionId);
      }

      // 2. Remove current position
      if (this.state.currentPositionId) {
        await this.removeLiquidity(this.state.currentPositionId);
      }

      // 3. Place order to buy USDC at lower price
      // When price is below lower limit, place order to buy USDC at lower price (sell USDT)
      const lowerBinId = this.priceToBinId(this.config.lowerPrice);
      await this.addLiquidityAtBin(lowerBinId, 'USDT');

      // 4. Update state
      this.state.currentToken = 'USDC';
      this.state.lastActionTime = Date.now();

      console.log('✅ USDC purchase completed, switching to USDC mode');
    } catch (error) {
      console.error('❌ Failed to buy USDC:', error);
      throw error;
    }
  }

  /**
   * Execute buy USDT operation (sell USDC)
   */
  private async executeBuyUSDT(): Promise<void> {
    try {
      // 1. Collect accumulated fees and rewards
      if (this.state.currentPositionId) {
        await this.collectFeesAndRewards(this.state.currentPositionId);
      }

      // 2. Remove current position
      if (this.state.currentPositionId) {
        await this.removeLiquidity(this.state.currentPositionId);
      }

      // 3. Place order to buy USDT at higher price
      // When price exceeds upper limit, place order to buy USDT at higher price (sell USDC)
      const upperBinId = this.priceToBinId(this.config.upperPrice);
      await this.addLiquidityAtBin(upperBinId, 'USDC');

      // 4. Update state
      this.state.currentToken = 'USDT';
      this.state.lastActionTime = Date.now();

      console.log('✅ USDT purchase completed, switching to USDT mode');
    } catch (error) {
      console.error('❌ Failed to buy USDT:', error);
      throw error;
    }
  }

  /**
   * Add liquidity at specified bin
   * Use Fixed Amount method for single-sided market making
   */
  private async addLiquidityAtBin(binId: number, tokenType: 'USDT' | 'USDC'): Promise<void> {
    try {
      // Use full balance of corresponding token
      const balances = await this.getTokenBalances();
      const amount = tokenType === 'USDC' ? balances.usdc : balances.usdt;

      if (parseFloat(amount) <= 0) {
        throw new Error(`❌ Insufficient ${tokenType} balance, cannot add liquidity`);
      }

      // Get pool information to get active_id
      const pool = await this.sdk.Pool.getPool(this.poolAddress!);

      // Check if active bin is in range
      const amountsInActiveBin = await this.sdk.Position.getActiveBinIfInRange(
        pool.bin_manager.bin_manager_handle,
        binId,
        binId,
        pool.active_id,
        this.config.binStep
      );

      // Use Fixed Amount method to calculate liquidity distribution
      // fix_amount_a: true for USDC, false for USDT
      const fixAmountA = tokenType === 'USDC';

      const calculateOption = {
        coin_amount: amount,
        fix_amount_a: fixAmountA,
        active_id: pool.active_id,
        bin_step: this.config.binStep,
        lower_bin_id: binId,
        upper_bin_id: binId,
        amount_a_in_active_bin: amountsInActiveBin?.amount_a || '0',
        amount_b_in_active_bin: amountsInActiveBin?.amount_b || '0',
        strategy_type: StrategyType.Spot
      };

      const binInfos = await this.sdk.Position.calculateAddLiquidityInfo(calculateOption);

      // Check if there's a position ID to decide whether to add liquidity or create new position
      if (this.state.currentPositionId) {
        // Add to existing position
        const addLiquidityOption = {
          pool_id: this.poolAddress!,
          bin_infos: binInfos,
          coin_type_a: this.config.tokenA,
          coin_type_b: this.config.tokenB,
          active_id: pool.active_id,
          position_id: this.state.currentPositionId,
          collect_fee: true,
          reward_coins: [],
          strategy_type: StrategyType.Spot,
          use_bin_infos: false,
          max_price_slippage: this.config.slippage,
          bin_step: this.config.binStep
        };

        const tx = this.sdk.Position.addLiquidityPayload(addLiquidityOption);

        // Execute transaction
        const result = await this.client.signAndExecuteTransaction({
          transaction: tx,
          signer: this.keypair,
          options: { showEffects: true }
        });

        console.log(`✅ Successfully added liquidity at bin ${binId} (existing position), transaction hash: ${result.digest}`);
      } else {
        // Create new position
        const openPositionOption = {
          pool_id: this.poolAddress!,
          bin_infos: binInfos,
          coin_type_a: this.config.tokenA,
          coin_type_b: this.config.tokenB,
          lower_bin_id: binId,
          upper_bin_id: binId,
          active_id: pool.active_id,
          strategy_type: StrategyType.Spot,
          use_bin_infos: false,
          max_price_slippage: this.config.slippage,
          bin_step: this.config.binStep
        };

        const tx = this.sdk.Position.addLiquidityPayload(openPositionOption);

        // Execute transaction
        const result = await this.client.signAndExecuteTransaction({
          transaction: tx,
          signer: this.keypair,
          options: { showEffects: true }
        });

        // Update position information
        this.state.currentPositionId = this.extractPositionId(result);
        this.state.currentBinId = binId;

        console.log(`✅ Successfully created new position at bin ${binId}, transaction hash: ${result.digest}`);
      }
    } catch (error) {
      console.error('❌ Failed to add liquidity:', error);
      throw error;
    }
  }

  /**
   * Remove liquidity
   * Determine which token to remove based on current strategy state
   */
  private async removeLiquidity(positionId: string): Promise<void> {
    try {
      // Get position information
      const position = await this.sdk.Position.getPosition(positionId);

      // Get pool information
      const pool = await this.sdk.Pool.getPool(this.poolAddress!);

      // Get current active bin information
      const activeBin = await this.sdk.Pool.getBinInfo(
        pool.bin_manager.bin_manager_handle,
        pool.active_id,
        pool.bin_step
      );

      // Parse liquidity shares data
      const liquiditySharesData = parseLiquidityShares(
        position.liquidity_shares, // Use correct property name
        pool.bin_step,
        position.lower_bin_id,
        activeBin
      );

      // Determine which token to remove based on current strategy state
      // - If currently holding USDT, remove liquidity to get USDC (because we're buying USDC)
      // - If currently holding USDC, remove liquidity to get USDT (because we're buying USDT)
      const isOnlyA = this.state.currentToken === 'USDT'; // true: remove only tokenA (USDC), false: remove only tokenB (USDT)

      console.log(`🔄 Removing liquidity, currently holding: ${this.state.currentToken}, removing token: ${isOnlyA ? 'USDC' : 'USDT'}`);

      // Calculate remove liquidity information - remove only one token
      const removeOption = {
        bins: liquiditySharesData.bins, // Use parsed bins data
        active_id: pool.active_id,
        is_only_a: isOnlyA, // true for token A (USDC), false for token B (USDT)
        coin_amount: this.config.positionSize // Remove specified amount
      };

      const removalInfo = this.sdk.Position.calculateRemoveLiquidityInfo(removeOption);

      // Remove liquidity
      const removeLiquidityOption = {
        pool_id: this.poolAddress!,
        position_id: positionId,
        active_id: pool.active_id,
        bin_step: this.config.binStep,
        bin_infos: removalInfo,
        slippage: this.config.slippage,
        coin_type_a: this.config.tokenA,
        coin_type_b: this.config.tokenB,
        collect_fee: true,
        reward_coins: []
      };

      const tx = this.sdk.Position.removeLiquidityPayload(removeLiquidityOption);

      // Execute transaction
      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: this.keypair,
        options: { showEffects: true }
      });

      console.log(`✅ Successfully removed liquidity, obtained ${isOnlyA ? 'USDC' : 'USDT'}, transaction hash: ${result.digest}`);

      // Clear position information
      this.state.currentPositionId = undefined;
      this.state.currentBinId = undefined;
    } catch (error) {
      console.error('❌ Failed to remove liquidity:', error);
      throw error;
    }
  }

  /**
   * Collect trading fees and rewards
   * Collect accumulated fees before removing liquidity or periodically
   */
  private async collectFeesAndRewards(positionId: string): Promise<void> {
    try {
      if (!this.poolAddress) {
        console.log('⚠️ Pool address not initialized, skipping fee collection');
        return;
      }

      // Get pool information
      const pool = await this.sdk.Pool.getPool(this.poolAddress);

      // Build transaction to collect fees and rewards
      const tx = this.sdk.Position.collectRewardAndFeePayload([{
        pool_id: this.poolAddress,
        position_id: positionId,
        reward_coins: pool.reward_manager.rewards.map((reward: any) => reward.reward_coin),
        coin_type_a: this.config.tokenA,
        coin_type_b: this.config.tokenB
      }]);

      // Execute transaction
      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: this.keypair,
        options: { showEffects: true }
      });

      console.log(`💰 Successfully collected fees and rewards, transaction hash: ${result.digest}`);

    } catch (error) {
      console.error('❌ Failed to collect fees and rewards:', error);
      // Don't throw error, because collection failure shouldn't stop strategy execution
    }
  }

  /**
   * Convert price to bin ID
   */
  private priceToBinId(price: string): number {
    const decimalA = 6; // USDC precision
    const decimalB = 6; // USDT precision

    return BinUtils.getBinIdFromPrice(
      price,
      this.config.binStep,
      false, // min
      decimalA,
      decimalB
    );
  }

  /**
   * Query current token balances
   */
  private async getTokenBalances(): Promise<{ usdc: string; usdt: string }> {
    try {
      const USDCType = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
      const USDTType = '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT';

      const [usdcBalance, usdtBalance] = await Promise.all([
        this.client.getBalance({ owner: this.config.senderAddress, coinType: USDCType }),
        this.client.getBalance({ owner: this.config.senderAddress, coinType: USDTType })
      ]);

      const balances = {
        usdc: new BN(usdcBalance.totalBalance).toString(),
        usdt: new BN(usdtBalance.totalBalance).toString()
      };

      // Update balance information in state
      this.state.currentBalance = balances;

      console.log(`💰 Balance query: USDC=${balances.usdc}, USDT=${balances.usdt}`);
      return balances;

    } catch (error) {
      console.error('❌ Failed to query balances:', error);
      // Return default values
      return { usdc: '0', usdt: '0' };
    }
  }

  /**
   * Detect balances and select initial token
   */
  private async detectInitialToken(): Promise<void> {
    try {
      const balances = await this.getTokenBalances();

      const usdcBalance = parseFloat(balances.usdc);
      const usdtBalance = parseFloat(balances.usdt);

      console.log(`💰 Balance detection: USDC=${usdcBalance}, USDT=${usdtBalance}`);

      if (usdcBalance > usdtBalance) {
        this.state.currentToken = 'USDC';
        console.log(`🎯 Selected initial token: USDC (higher balance: ${usdcBalance} > ${usdtBalance})`);
      } else if (usdtBalance > usdcBalance) {
        this.state.currentToken = 'USDT';
        console.log(`🎯 Selected initial token: USDT (higher balance: ${usdtBalance} > ${usdcBalance})`);
      } else {
        // When balances are equal, default to USDT
        this.state.currentToken = 'USDT';
        console.log(`🎯 Selected initial token: USDT (balances equal, using default)`);
      }

      console.log(`📊 Initial strategy direction: Sell ${this.state.currentToken}, buy ${this.state.currentToken === 'USDC' ? 'USDT' : 'USDC'}`);

    } catch (error) {
      console.error('❌ Balance detection failed:', error);

      // Check if there are existing positions
      const existingPositions = await this.getExistingPositions();
      if (existingPositions.length > 0) {
        console.log('📋 Found existing positions, using existing position state');
        // If there are existing positions, keep current state unchanged and let strategy continue
        return;
      }

      // If no existing positions, use default token
      console.log('⚠️ Using default token USDT');
      this.state.currentToken = 'USDT'; // Default to USDT
    }
  }


  /**
   * Extract position ID from transaction result
   */
  private extractPositionId(result: any): string {
    try {
      // Find created Position object from transaction result
      const createdObjects = result.effects?.created || [];
      const positionObject = createdObjects.find((obj: any) =>
        obj.objectType?.includes('position::Position')
      );

      if (positionObject) {
        return positionObject.objectId;
      }

      // If not found, try to find from events
      const events = result.effects?.events || [];
      for (const event of events) {
        if (event.type === 'position::PositionCreated') {
          return event.positionId;
        }
      }

      console.warn('⚠️ Unable to extract position ID from transaction result, using default value');
      return '0xposition123';
    } catch (error) {
      console.error('❌ Failed to extract position ID:', error);
      return '0xposition123';
    }
  }

  /**
   * Query all positions for current address
   */
  private async getExistingPositions(): Promise<string[]> {
    try {
      const positionType = '0x5664f9d3fd82c84023870cfbda8ea84e14c8dd56ce557ad2116e0668581a682b::position::Position';
      const ownedObjects = await this.client.getOwnedObjects({
        owner: this.config.senderAddress,
        filter: {
          StructType: positionType
        }
      });

      const positionIds = ownedObjects.data.map(obj => obj.data?.objectId).filter((id): id is string => Boolean(id));
      console.log(`📋 Found ${positionIds.length} existing positions`);
      return positionIds;
    } catch (error) {
      console.error('❌ Failed to query existing positions:', error);
      return [];
    }
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取策略状态
   */
  getStatus(): StrategyConfig & PositionState {
    return {
      ...this.config,
      ...this.state
    };
  }

  /**
   * Get current price explanation
   */
  async getPriceExplanation(): Promise<string> {
    try {
      const currentPrice = await this.getCurrentPrice();
      return `
📊 Price explanation:
- Current price: ${currentPrice} (USDC/USDT)
- When price > 1: USDC appreciates relative to USDT
- When price < 1: USDC depreciates relative to USDT
- Currently holding: ${this.state.currentToken}
- Strategy range: ${this.config.lowerPrice} - ${this.config.upperPrice}
    `;
    } catch (error) {
      return `
📊 Price explanation:
- Current price: Failed to get (USDC/USDT)
- When price > 1: USDC appreciates relative to USDT
- When price < 1: USDC depreciates relative to USDT
- Currently holding: ${this.state.currentToken}
- Strategy range: ${this.config.lowerPrice} - ${this.config.upperPrice}
    `;
    }
  }
}