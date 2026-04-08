// @ts-nocheck
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import {
  CHAIN_ID_SOLANA,
  ChainId,
} from "@certusone/wormhole-sdk";
import logger from "./logger";
import {Contract, ethers} from "ethers";
import {createTransferQueue, TransferTask} from "./common";

const SOLANA_ORACLE_EMITTER = "3C7vHjyefdDqWqzU2hxwUCFQD9kMiD1SCWWqmEj6HrQG";
const DISPATCHER_PROXY = "0x32d53dc510a4cdbb4634207e0e1e64b552a1c24c";

const moonbeam = new ethers.providers.JsonRpcProvider(process.env.MOONBEAM_RPC || 'https://moonbeam-rpc.n.dwellir.com');
const signer = new ethers.Wallet(process.env.PRIVKEY, moonbeam);
const dispatcher = new Contract(
  DISPATCHER_PROXY,
  ['function receiveMessage(bytes memory vaa) external'],
  signer
);

(async function main() {
  const queue = createTransferQueue(moonbeam, signer, async (task: TransferTask, nonce: number) => {
    task.logger.info(`Submitting oracle VAA to dispatcher`);
    await dispatcher.callStatic.receiveMessage(task.vaa.bytes, {nonce});
    task.logger.info(`Completing oracle relay`);
    const tx = await dispatcher.receiveMessage(task.vaa.bytes, {nonce});
    await tx.wait();
    return tx.hash;
  });

  const currentNonce = await queue.initNonce();
  logger.info(`Oracle relayer starting`);
  logger.info(`account ${signer.address}`);
  logger.info(`nonce ${currentNonce}`);
  logger.info(`Watching Solana oracle emitter: ${SOLANA_ORACLE_EMITTER}`);
  logger.info(`Submitting to Dispatcher on Moonbeam: ${DISPATCHER_PROXY}`);

  const app = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      name: process.env.ORACLE_APP_NAME || `oracle-relayer`,
      logger,
      spyEndpoint: process.env.SPY_ENDPOINT || "localhost:7073",
      redis: {host: process.env.REDIS_HOST || "localhost", port: Number(process.env.REDIS_PORT) || 6379},
      missedVaaOptions: {
        startingSequenceConfig: {
          [CHAIN_ID_SOLANA as ChainId]: BigInt(process.env.ORACLE_SOLANA_FROM_SEQ || 0),
        }
      }
    },
  );

  app.chain(CHAIN_ID_SOLANA as ChainId).address(
    SOLANA_ORACLE_EMITTER,
    async (ctx, next) => {
      const {vaa} = ctx;
      const ctxLogger = logger.child({
        emitterChain: vaa.emitterChain,
        sequence: vaa.sequence.toString(),
      });

      ctxLogger.info(`Received oracle message from Solana`);
      queue.addToQueue({vaa, type: 'oracle', logger: ctxLogger, next});
    },
  );

  await app.listen();
})();
