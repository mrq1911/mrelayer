import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import {CHAIN_ID_ACALA, CHAIN_ID_ETH, CHAIN_ID_MOONBEAM, CHAIN_ID_SOLANA, ChainId, TokenBridgePayload} from "@certusone/wormhole-sdk";
import logger from "./logger";
import {Contract, ethers} from "ethers";
import {VersionedUserAction} from "./gmp";

const MRL_ADDRESS = "0000000000000000000000000000000000000000000000000000000000000816";
const moonbeam = new ethers.providers.JsonRpcProvider(process.env.MOONBEAM_RPC || 'https://moonbeam-rpc.n.dwellir.com');
const signer = new ethers.Wallet(process.env.PRIVKEY, moonbeam);
const gmp = new Contract('0x0000000000000000000000000000000000000816', ['function wormholeTransferERC20(bytes) external'], signer);

(async function main() {
  let currentNonce = await moonbeam.getTransactionCount(signer.address);
  const nextNonce = () => currentNonce++
  logger.info(`account ${signer.address}`);
  logger.info(`nonce ${currentNonce}`);

  const app = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      name: process.env.APP_NAME || `mrelayer11`,
      logger,
      spyEndpoint: process.env.SPY_ENDPOINT || "localhost:7073",
      redis: { host: process.env.REDIS_HOST || "localhost", port: Number(process.env.REDIS_PORT) || 6379 },
      missedVaaOptions: {
        startingSequenceConfig: {
          [CHAIN_ID_ACALA as ChainId]: BigInt(process.env.ACA_FROM_SEQ || 2600),
          [CHAIN_ID_ETH as ChainId]: BigInt(process.env.ETH_FROM_SEQ || 269379),
          [CHAIN_ID_SOLANA as ChainId]: BigInt(process.env.SOLANA_FROM_SEQ || 313796945),
        }
      }
    },
  );

  app.tokenBridge([CHAIN_ID_ACALA, CHAIN_ID_ETH, CHAIN_ID_SOLANA],
    async (ctx, next) => {
      const { payload } = ctx.tokenBridge;
      const { vaa, sourceTxHash } = ctx;
      const {payloadType, toChain, tokenTransferPayload} = payload;
      const to = payload.to.toString("hex");
      const logger = ctx.logger.child({sourceTxHash});

      if (payloadType === TokenBridgePayload.TransferWithPayload
          && toChain === CHAIN_ID_MOONBEAM
          && to === MRL_ADDRESS) {

        // TODO parse payload to filter only hydra ones
        //new VersionedUserAction('0x' + tokenTransferPayload.toString("hex"))

        try {
          logger.info(`Found VAA`);
          await gmp.callStatic.wormholeTransferERC20(vaa.bytes, {nonce: currentNonce})
          logger.info(`Completing transfer`);
          const tx = await gmp.wormholeTransferERC20(vaa.bytes, {nonce: nextNonce()});
          logger.info(`Transfer completed in ${tx.hash}`);
          return next();
        } catch (e) {
          const text = JSON.stringify(e);
          if (text.indexOf('transfer already completed') !== -1) {
            logger.info(`Transfer already completed`);
            return next();
          }
          if (text.indexOf('Invalid GMP Payload') !== -1) {
            logger.info(`Invalid GMP payload`);
            return next();
          }
          ctx.logger.error(e.error || e.message || e);
        }
      }
    },
  );

  await app.listen();
})();
