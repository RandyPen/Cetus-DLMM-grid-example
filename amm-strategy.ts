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
   * 移除流动性
   * 根据当前策略状态决定移除哪种代币
   */
  private async removeLiquidity(positionId: string): Promise<void> {
    try {
      // 获取仓位信息
      const position = await this.sdk.Position.getPosition(positionId);

      // 获取池信息
      const pool = await this.sdk.Pool.getPool(this.poolAddress!);

      // 获取当前 active bin 信息
      const activeBin = await this.sdk.Pool.getBinInfo(
        pool.bin_manager.bin_manager_handle,
        pool.active_id,
        pool.bin_step
      );

      // 解析流动性份额数据
      const liquiditySharesData = parseLiquidityShares(
        position.liquidity_shares, // 使用正确的属性名
        pool.bin_step,
        position.lower_bin_id,
        activeBin
      );

      // 根据当前策略状态决定移除哪种代币
      // - 如果当前持有 USDT，移除流动性时应该获取 USDC（因为我们正在买入 USDC）
      // - 如果当前持有 USDC，移除流动性时应该获取 USDT（因为我们正在买入 USDT）
      const isOnlyA = this.state.currentToken === 'USDT'; // true: 只移除 tokenA (USDC), false: 只移除 tokenB (USDT)

      console.log(`🔄 移除流动性，当前持有: ${this.state.currentToken}, 移除代币: ${isOnlyA ? 'USDC' : 'USDT'}`);

      // 计算移除流动性信息 - 只移除一种代币
      const removeOption = {
        bins: liquiditySharesData.bins, // 使用解析后的 bins 数据
        active_id: pool.active_id,
        is_only_a: isOnlyA, // true for token A (USDC), false for token B (USDT)
        coin_amount: this.config.positionSize // 移除指定金额
      };

      const removalInfo = this.sdk.Position.calculateRemoveLiquidityInfo(removeOption);

      // 移除流动性
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

      // 执行交易
      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: this.keypair,
        options: { showEffects: true }
      });

      console.log(`✅ 移除流动性成功，获取 ${isOnlyA ? 'USDC' : 'USDT'}，交易哈希: ${result.digest}`);

      // 清空仓位信息
      this.state.currentPositionId = undefined;
      this.state.currentBinId = undefined;
    } catch (error) {
      console.error('❌ 移除流动性失败:', error);
      throw error;
    }
  }

  /**
   * 领取交易费和奖励
   * 在移除流动性前或定期领取累积的费用
   */
  private async collectFeesAndRewards(positionId: string): Promise<void> {
    try {
      if (!this.poolAddress) {
        console.log('⚠️ 池地址未初始化，跳过领取费用');
        return;
      }

      // 获取池信息
      const pool = await this.sdk.Pool.getPool(this.poolAddress);

      // 构建领取费用和奖励的交易
      const tx = this.sdk.Position.collectRewardAndFeePayload([{
        pool_id: this.poolAddress,
        position_id: positionId,
        reward_coins: pool.reward_manager.rewards.map((reward: any) => reward.reward_coin),
        coin_type_a: this.config.tokenA,
        coin_type_b: this.config.tokenB
      }]);

      // 执行交易
      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: this.keypair,
        options: { showEffects: true }
      });

      console.log(`💰 领取费用和奖励成功，交易哈希: ${result.digest}`);

    } catch (error) {
      console.error('❌ 领取费用和奖励失败:', error);
      // 不抛出错误，因为领取失败不应该阻止策略执行
    }
  }

  /**
   * 价格转 bin ID
   */
  private priceToBinId(price: string): number {
    const decimalA = 6; // USDC 精度
    const decimalB = 6; // USDT 精度

    return BinUtils.getBinIdFromPrice(
      price,
      this.config.binStep,
      false, // min
      decimalA,
      decimalB
    );
  }

  /**
   * 查询当前代币余额
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

      // 更新状态中的余额信息
      this.state.currentBalance = balances;

      console.log(`💰 余额查询: USDC=${balances.usdc}, USDT=${balances.usdt}`);
      return balances;

    } catch (error) {
      console.error('❌ 查询余额失败:', error);
      // 返回默认值
      return { usdc: '0', usdt: '0' };
    }
  }

  /**
   * 检测余额并选择初始代币
   */
  private async detectInitialToken(): Promise<void> {
    try {
      const balances = await this.getTokenBalances();

      const usdcBalance = parseFloat(balances.usdc);
      const usdtBalance = parseFloat(balances.usdt);

      console.log(`💰 余额检测: USDC=${usdcBalance}, USDT=${usdtBalance}`);

      if (usdcBalance > usdtBalance) {
        this.state.currentToken = 'USDC';
        console.log(`🎯 选择初始代币: USDC (余额较多: ${usdcBalance} > ${usdtBalance})`);
      } else if (usdtBalance > usdcBalance) {
        this.state.currentToken = 'USDT';
        console.log(`🎯 选择初始代币: USDT (余额较多: ${usdtBalance} > ${usdcBalance})`);
      } else {
        // 余额相等时，默认使用 USDT
        this.state.currentToken = 'USDT';
        console.log(`🎯 选择初始代币: USDT (余额相等，使用默认)`);
      }

      console.log(`📊 初始策略方向: 卖出 ${this.state.currentToken}，买入 ${this.state.currentToken === 'USDC' ? 'USDT' : 'USDC'}`);

    } catch (error) {
      console.error('❌ 余额检测失败:', error);

      // 检查是否有现有仓位
      const existingPositions = await this.getExistingPositions();
      if (existingPositions.length > 0) {
        console.log('📋 发现现有仓位，使用现有仓位状态');
        // 如果有现有仓位，保持当前状态不变，让策略继续运行
        return;
      }

      // 如果没有现有仓位，使用默认代币
      console.log('⚠️ 使用默认代币 USDT');
      this.state.currentToken = 'USDT'; // 默认使用 USDT
    }
  }


  /**
   * 从交易结果中提取仓位 ID
   */
  private extractPositionId(result: any): string {
    try {
      // 从交易结果中查找创建的 Position 对象
      const createdObjects = result.effects?.created || [];
      const positionObject = createdObjects.find((obj: any) =>
        obj.objectType?.includes('position::Position')
      );

      if (positionObject) {
        return positionObject.objectId;
      }

      // 如果没找到，尝试从事件中查找
      const events = result.effects?.events || [];
      for (const event of events) {
        if (event.type === 'position::PositionCreated') {
          return event.positionId;
        }
      }

      console.warn('⚠️ 无法从交易结果中提取仓位 ID，使用默认值');
      return '0xposition123';
    } catch (error) {
      console.error('❌ 提取仓位 ID 失败:', error);
      return '0xposition123';
    }
  }

  /**
   * 查询当前地址的所有仓位
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
      console.log(`📋 找到 ${positionIds.length} 个现有仓位`);
      return positionIds;
    } catch (error) {
      console.error('❌ 查询现有仓位失败:', error);
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
   * 获取当前价格解释
   */
  async getPriceExplanation(): Promise<string> {
    try {
      const currentPrice = await this.getCurrentPrice();
      return `
📊 价格解释:
- 当前价格: ${currentPrice} (USDC/USDT)
- 当价格 > 1 时: USDC 相对于 USDT 升值
- 当价格 < 1 时: USDC 相对于 USDT 贬值
- 当前持有: ${this.state.currentToken}
- 策略区间: ${this.config.lowerPrice} - ${this.config.upperPrice}
    `;
    } catch (error) {
      return `
📊 价格解释:
- 当前价格: 获取失败 (USDC/USDT)
- 当价格 > 1 时: USDC 相对于 USDT 升值
- 当价格 < 1 时: USDC 相对于 USDT 贬值
- 当前持有: ${this.state.currentToken}
- 策略区间: ${this.config.lowerPrice} - ${this.config.upperPrice}
    `;
    }
  }
}