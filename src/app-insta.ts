// @ts-nocheck
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import {
  CHAIN_ID_BASE,
  ChainId,
} from "@certusone/wormhole-sdk";
import logger from "./logger";
import {Contract, ethers} from "ethers";
import {createTransferQueue, TransferTask} from "./common";

// InstaBridge proxy on Base (emits fast-path Wormhole messages)
const INSTA_BRIDGE_BASE = process.env.INSTA_BRIDGE_BASE || "0x73bab4cec782e1530117932cef8492ebe64e112e";

// InstaBridgeProxy on Moonbeam (receives fast-path VAAs, dispatches via XCM to Hydration)
const INSTA_BRIDGE_MOONBEAM = process.env.INSTA_BRIDGE_MOONBEAM || "0x54c8ff9230627ed7bd5d7704f60018e47f36f233";

const moonbeam = new ethers.providers.JsonRpcProvider(process.env.MOONBEAM_RPC || 'https://moonbeam-rpc.n.dwellir.com');
const signer = new ethers.Wallet(process.env.PRIVKEY, moonbeam);
const instaBridgeProxy = new Contract(
  INSTA_BRIDGE_MOONBEAM,
  ['function completeTransfer(bytes memory vaa) external'],
  signer
);

(async function main() {
  const queue = createTransferQueue(moonbeam, signer, async (task: TransferTask, nonce: number) => {
    task.logger.info(`Found instant VAA, completing transfer on Moonbeam`);
    await instaBridgeProxy.callStatic.completeTransfer(task.vaa.bytes, {nonce});
    task.logger.info(`Completing insta transfer`);
    const tx = await instaBridgeProxy.completeTransfer(task.vaa.bytes, {nonce});
    await tx.wait();
    return tx.hash;
  });

  const currentNonce = await queue.initNonce();
  logger.info(`Insta relayer starting`);
  logger.info(`account ${signer.address}`);
  logger.info(`nonce ${currentNonce}`);
  logger.info(`Watching InstaBridge on Base: ${INSTA_BRIDGE_BASE}`);
  logger.info(`Submitting to InstaBridgeProxy on Moonbeam: ${INSTA_BRIDGE_MOONBEAM}`);

  const app = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      name: process.env.APP_NAME || `insta-relayer`,
      logger,
      spyEndpoint: process.env.SPY_ENDPOINT || "localhost:7073",
      redis: {host: process.env.REDIS_HOST || "localhost", port: Number(process.env.REDIS_PORT) || 6379},
    },
  );

  // Listen for fast-path messages from InstaBridge on Base
  app.chain(CHAIN_ID_BASE as ChainId).address(
    INSTA_BRIDGE_BASE,
    async (ctx, next) => {
      const {vaa} = ctx;
      const ctxLogger = logger.child({
        emitterChain: vaa.emitterChain,
        sequence: vaa.sequence.toString(),
      });

      ctxLogger.info(`Received instant message from InstaBridge on Base`);

      queue.addToQueue({vaa, logger: ctxLogger, next});
    },
  );

  await app.listen();
})();
