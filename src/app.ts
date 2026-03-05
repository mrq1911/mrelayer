// @ts-nocheck
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import {
  CHAIN_ID_ACALA,
  CHAIN_ID_BASE,
  CHAIN_ID_ETH,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_SOLANA,
  CHAIN_ID_SUI,
  ChainId,
  TokenBridgePayload
} from "@certusone/wormhole-sdk";
import logger from "./logger";
import {Contract, ethers} from "ethers";
import {getPayloadWithFallback, createTransferQueue, TransferTask} from "./common";

const MRL_ADDRESS = "0000000000000000000000000000000000000000000000000000000000000816";
const moonbeam = new ethers.providers.JsonRpcProvider(process.env.MOONBEAM_RPC || 'https://moonbeam-rpc.n.dwellir.com');
const signer = new ethers.Wallet(process.env.PRIVKEY, moonbeam);
const gmp = new Contract('0x0000000000000000000000000000000000000816', ['function wormholeTransferERC20(bytes) external'], signer);

(async function main() {
  const queue = createTransferQueue(moonbeam, signer, async (task: TransferTask, nonce: number) => {
    task.logger.info(`Found VAA`);
    await gmp.callStatic.wormholeTransferERC20(task.vaa.bytes, {nonce});
    task.logger.info(`Completing transfer`);
    const tx = await gmp.wormholeTransferERC20(task.vaa.bytes, {nonce});
    await tx.wait();
    return tx.hash;
  });

  const currentNonce = await queue.initNonce();
  logger.info(`account ${signer.address}`);
  logger.info(`nonce ${currentNonce}`);

  const app = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      name: process.env.APP_NAME || `mrelayer11`,
      logger,
      spyEndpoint: process.env.SPY_ENDPOINT || "localhost:7073",
      redis: {host: process.env.REDIS_HOST || "localhost", port: Number(process.env.REDIS_PORT) || 6379},
      missedVaaOptions: {
        startingSequenceConfig: {
          [CHAIN_ID_ACALA as ChainId]: BigInt(process.env.ACA_FROM_SEQ || 3358),
          [CHAIN_ID_BASE as ChainId]: BigInt(process.env.BASE_FROM_SEQ || 244981),
          [CHAIN_ID_ETH as ChainId]: BigInt(process.env.ETH_FROM_SEQ || 499562),
          [CHAIN_ID_SOLANA as ChainId]: BigInt(process.env.SOLANA_FROM_SEQ || 1211243),
          [CHAIN_ID_SUI as ChainId]: BigInt(process.env.SUI_FROM_SEQ || 217370),
        }
      }
    },
  );

  app.tokenBridge([CHAIN_ID_ACALA, CHAIN_ID_BASE, CHAIN_ID_ETH, CHAIN_ID_SOLANA, CHAIN_ID_SUI],
    async (ctx, next) => {
      const {vaa, sourceTxHash} = ctx;
      const ctxLogger = ctx.logger.child({sourceTxHash});

      const payload = await getPayloadWithFallback(ctx, ctxLogger);

      if (!payload) {
        ctxLogger.info('No payload available from any source');
        return next();
      }
      ctxLogger.debug('payload', payload);

      const {payloadType, toChain} = payload;
      const to = payload.to.toString("hex");

      if (payloadType === TokenBridgePayload.TransferWithPayload
          && toChain === CHAIN_ID_MOONBEAM) {
        ctxLogger.info("Found message to MOONBEAM:", {to});

        if (to === MRL_ADDRESS) {
          queue.addToQueue({vaa, logger: ctxLogger, next});
        } else {
          ctxLogger.info(`Message not for MRL address. Target: ${to}, Expected: ${MRL_ADDRESS}`);
          return next();
        }
      } else {
        ctxLogger.info(`Message not for processing. PayloadType: ${payloadType}, ToChain: ${toChain}`);
        return next();
      }
    },
  );

  await app.listen();
})();
