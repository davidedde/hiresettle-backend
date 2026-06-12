import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Networks,
  SorobanRpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

/**
 * StellarService
 *
 * Provides:
 *  - Soroban RPC client for querying the Stellar network
 *  - Contract event fetching (used by EventsService poller)
 *  - Read-only contract call simulation
 *  - Retention timer utilities:
 *      - ledgersToDateTime() — converts a ledger sequence to estimated wall-clock time
 *      - dateTimeToLedger()  — estimates the ledger for a given future datetime
 *  - USDC/stroops conversion helpers
 *
 * This service does NOT hold user funds. The backend Stellar keypair
 * is used only for read-only RPC calls.
 */
@Injectable()
export class StellarService implements OnModuleInit {
  private readonly logger = new Logger(StellarService.name);

  private rpcClient: SorobanRpc.Server;
  private networkPassphrase: string;
  private contractId: string;
  private readonly LEDGERS_PER_DAY = 17_280; // 86400s ÷ 5s per ledger

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const rpcUrl = this.config.get<string>('STELLAR_RPC_URL');
    const networkName = this.config.get<string>('STELLAR_NETWORK', 'testnet');

    this.rpcClient = new SorobanRpc.Server(rpcUrl, { allowHttp: true });
    this.contractId = this.config.get<string>('HIRESETTLE_CONTRACT_ID');
    this.networkPassphrase =
      networkName === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

    this.logger.log(`Stellar connected to ${networkName} (${rpcUrl})`);
    this.logger.log(`Contract: ${this.contractId}`);
  }

  // ----------------------------------------------------------
  // RPC ACCESS
  // ----------------------------------------------------------

  getClient(): SorobanRpc.Server { return this.rpcClient; }
  getNetworkPassphrase(): string { return this.networkPassphrase; }
  getContractId(): string { return this.contractId; }

  // ----------------------------------------------------------
  // EVENT FETCHING
  // ----------------------------------------------------------

  /**
   * Fetch HireSettle contract events from a given ledger range.
   * Called by EventsService every 5 seconds.
   */
  async fetchContractEvents(
    startLedger: number,
  ): Promise<SorobanRpc.Api.EventResponse[]> {
    try {
      const result = await this.rpcClient.getEvents({
        startLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [this.contractId],
          },
        ],
        limit: 100,
      });
      return result.events ?? [];
    } catch (error) {
      this.logger.error(`Failed to fetch events from ledger ${startLedger}`, error.message);
      return [];
    }
  }

  // ----------------------------------------------------------
  // READ-ONLY CONTRACT SIMULATION
  // ----------------------------------------------------------

  /**
   * Simulate a read-only contract call (e.g. get_engagement, ledgers_until_unlock).
   * Does not submit a transaction — no gas cost.
   */
  async simulateContractCall(method: string, args: xdr.ScVal[]): Promise<any> {
    try {
      const contract = new Contract(this.contractId);
      const dummyKeypair = Keypair.random();
      const dummyAccount = {
        accountId: () => dummyKeypair.publicKey(),
        sequenceNumber: () => '0',
        incrementSequenceNumber: () => {},
      } as any;

      const tx = new TransactionBuilder(dummyAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

      const simulation = await this.rpcClient.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation error: ${simulation.error}`);
      }
      if (SorobanRpc.Api.isSimulationSuccess(simulation) && simulation.result) {
        return scValToNative(simulation.result.retval);
      }
      return null;
    } catch (error) {
      this.logger.error(`simulateContractCall(${method}) failed`, error.message);
      throw error;
    }
  }

  // ----------------------------------------------------------
  // LEDGER — CURRENT
  // ----------------------------------------------------------

  async getLatestLedger(): Promise<number> {
    const info = await this.rpcClient.getLatestLedger();
    return info.sequence;
  }

  // ----------------------------------------------------------
  // RETENTION TIMER UTILITIES
  // ----------------------------------------------------------

  /**
   * Estimate the wall-clock DateTime for a future ledger sequence.
   * Used when creating RetentionSchedule records so the cron job
   * knows when to fire without re-querying the chain.
   *
   * Formula: now + ((targetLedger - currentLedger) × 5s)
   *
   * @param targetLedger   — the ledger sequence we want the datetime for
   * @param currentLedger  — the current ledger sequence (from getLatestLedger)
   * @returns estimated Date object
   */
  ledgerToDateTime(targetLedger: number, currentLedger: number): Date {
    const SECONDS_PER_LEDGER = 5;
    const ledgersAway = targetLedger - currentLedger;
    const secondsAway = ledgersAway * SECONDS_PER_LEDGER;
    return new Date(Date.now() + secondsAway * 1000);
  }

  /**
   * Estimate how many days remain until a ledger unlocks.
   * Used for display in notifications and the dashboard countdown.
   */
  ledgersToDays(ledgerCount: number): number {
    return Math.ceil(ledgerCount / this.LEDGERS_PER_DAY);
  }

  /**
   * Check on-chain whether a Locked milestone is now unlockable.
   * Calls is_milestone_unlockable() on the contract.
   */
  async isMilestoneUnlockable(
    engagementId: string,
    milestoneIndex: number,
  ): Promise<boolean> {
    try {
      const { nativeToScVal } = await import('@stellar/stellar-sdk');
      const result = await this.simulateContractCall('is_milestone_unlockable', [
        nativeToScVal(engagementId, { type: 'string' }),
        nativeToScVal(milestoneIndex, { type: 'u32' }),
      ]);
      return Boolean(result);
    } catch {
      return false;
    }
  }

  /**
   * Get the remaining ledgers until a milestone unlocks.
   * Calls ledgers_until_unlock() on the contract.
   */
  async ledgersUntilUnlock(
    engagementId: string,
    milestoneIndex: number,
  ): Promise<number> {
    try {
      const { nativeToScVal } = await import('@stellar/stellar-sdk');
      const result = await this.simulateContractCall('ledgers_until_unlock', [
        nativeToScVal(engagementId, { type: 'string' }),
        nativeToScVal(milestoneIndex, { type: 'u32' }),
      ]);
      return Number(result ?? 0);
    } catch {
      return 0;
    }
  }

  // ----------------------------------------------------------
  // USDC UTILITIES
  // ----------------------------------------------------------

  /** Convert stroops (i128 as string/bigint) to human-readable USDC */
  stroopsToUsdc(stroops: string | bigint, decimals = 2): string {
    const value = BigInt(stroops);
    const whole = value / 10_000_000n;
    const fraction = (value % 10_000_000n).toString().padStart(7, '0');
    return parseFloat(`${whole}.${fraction}`).toFixed(decimals);
  }

  /** Convert human-readable USDC amount to stroops */
  usdcToStroops(usdc: string): bigint {
    const [whole, fraction = ''] = usdc.split('.');
    const paddedFraction = fraction.padEnd(7, '0').slice(0, 7);
    return BigInt(whole) * 10_000_000n + BigInt(paddedFraction);
  }
}
