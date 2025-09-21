// @ts-nocheck
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import {
  CHAIN_ID_ACALA,
  CHAIN_ID_ETH,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_SOLANA, CHAIN_ID_SUI,
  ChainId,
  TokenBridgePayload
} from "@certusone/wormhole-sdk";
import logger from "./logger";
import {Contract, ethers} from "ethers";

const MRL_ADDRESS = "0000000000000000000000000000000000000000000000000000000000000816";
const moonbeam = new ethers.providers.JsonRpcProvider(process.env.MOONBEAM_RPC || 'https://moonbeam-rpc.n.dwellir.com');
const signer = new ethers.Wallet(process.env.PRIVKEY, moonbeam);
const gmp = new Contract('0x0000000000000000000000000000000000000816', ['function wormholeTransferERC20(bytes) external'], signer);

// Add fetch function for Wormhole API fallback
async function loadVaaFromWormholeApi(emitterChain: number, emitterAddr: string, sequence: number) {
  const url = `https://api.wormholescan.io/api/v1/vaas/${emitterChain}/${emitterAddr}/${sequence}?parsedPayload=true`;

  try {
    const response = await fetch(url);
    const apiData = await response.json();

    if (!apiData.data) {
      throw new Error('No VAA data found');
    }

    const {data} = apiData;
    const {payload} = data;

    // Extract variables matching the app's needs
    const vaaBytes = Buffer.from(data.vaa, 'base64');
    const to = payload.toAddress.replace('0x', '').toLowerCase();
    const toChain = payload.toChain;
    const payloadType = payload.payloadType;
    const amount = payload.amount;
    const fromAddress = payload.fromAddress;
    const tokenAddress = payload.tokenAddress;
    const tokenChain = payload.tokenChain;

    // Create a payload object compatible with existing logic
    const tokenBridgePayload = {
      payloadType,
      toChain,
      to: Buffer.from(to, 'hex'),
      tokenTransferPayload: {
        amount: BigInt(amount),
        fromAddress,
        tokenAddress,
        tokenChain
      }
    };

    return {
      payload: tokenBridgePayload,
      sourceTxHash: data.txHash,
      timestamp: data.timestamp,
      emitterChain: data.emitterChain,
      sequence: data.sequence,
      vaaBytes
    };

  } catch (error) {
    logger.error(`Failed to load VAA from Wormhole API: ${error.message}`);
    throw error;
  }
}

(async function main() {
  let currentNonce = await moonbeam.getTransactionCount(signer.address);
  const nextNonce = () => currentNonce++;
  logger.info(`account ${signer.address}`);
  logger.info(`nonce ${currentNonce}`);

  // Create a queue system to process transfers one by one
  type TransferTask = {
    vaa: any;
    logger: any;
    next: () => void;
  };

  const transferQueue: TransferTask[] = [];
  let isProcessing = false;

  async function processQueue() {
    if (isProcessing || transferQueue.length === 0) return;

    isProcessing = true;
    const task = transferQueue.shift()!;

    try {
      task.logger.info(`Found VAA`);
      await gmp.callStatic.wormholeTransferERC20(task.vaa.bytes, {nonce: currentNonce});
      task.logger.info(`Completing transfer`);
      const tx = await gmp.wormholeTransferERC20(task.vaa.bytes, {nonce: currentNonce});
      await tx.wait();
      task.logger.info(`Transfer completed in ${tx.hash}`);
      task.logger.info(`Next nonce: ${nextNonce()}`);
      task.next();
    } catch (e) {
      const text = JSON.stringify(e);
      if (text.indexOf('transfer already completed') !== -1) {
        task.logger.info(`Transfer already completed`);
        task.next();
      } else if (text.indexOf('Invalid GMP Payload') !== -1) {
        task.logger.error(`Invalid GMP payload`);
        task.next();
      } else if (text.indexOf('nonce too low') !== -1) {
        task.logger.info(`nonce too low, reloading nonce...`);
        currentNonce = await moonbeam.getTransactionCount(signer.address);
        // Re-add the task to the front of the queue
        transferQueue.unshift(task);
      } else {
        task.logger.error(e.error || e.message || e);
        task.next();
      }
    } finally {
      isProcessing = false;
      // Process the next item in the queue
      processQueue();
    }
  }

  function addToTransferQueue(task: TransferTask) {
    transferQueue.push(task);
    processQueue();
  }

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
          [CHAIN_ID_ETH as ChainId]: BigInt(process.env.ETH_FROM_SEQ || 499562),
          [CHAIN_ID_SOLANA as ChainId]: BigInt(process.env.SOLANA_FROM_SEQ || 1211243),
          [CHAIN_ID_SUI as ChainId]: BigInt(process.env.SUI_FROM_SEQ || 217370),
        }
      }
    },
  );

  app.tokenBridge([CHAIN_ID_ACALA, CHAIN_ID_ETH, CHAIN_ID_SOLANA, CHAIN_ID_SUI],
    async (ctx, next) => {
      const {vaa, sourceTxHash} = ctx;
      let {payload} = ctx.tokenBridge;
      const logger = ctx.logger.child({sourceTxHash});

      // If no payload, try loading from Wormhole API
      if (!payload) {
        logger.info('Payload missing, attempting to load from Wormhole API...');

        try {
          // Extract emitter info from VAA
          const emitterChain = vaa.emitterChain;
          const emitterAddr = vaa.emitterAddress.toString('hex');
          const sequence = vaa.sequence;

          logger.info(`Loading VAA ${emitterChain}/${emitterAddr}/${sequence} from API`);

          const apiVaaData = await loadVaaFromWormholeApi(emitterChain, emitterAddr, Number(sequence));
          payload = apiVaaData.payload;

          logger.info('Successfully loaded payload from Wormhole API');
          logger.debug('API payload', payload);
        } catch (error) {
          logger.error(`Failed to load from API: ${error.message}`);
          return next();
        }
      }

      if (!payload) {
        logger.info('No payload available from any source');
        return next();
      } else {
        logger.debug('payload', payload);
      }

      const {payloadType, toChain} = payload;
      const to = payload.to.toString("hex");

      if (payloadType === TokenBridgePayload.TransferWithPayload
          && toChain === CHAIN_ID_MOONBEAM) {
        logger.info("Found message to MOONBEAM:", {to});

        if (to === MRL_ADDRESS) {
          // Instead of calling completeTransfer directly, add to queue
          addToTransferQueue({
            vaa,
            logger,
            next
          });
        } else {
          logger.info(`Message not for MRL address. Target: ${to}, Expected: ${MRL_ADDRESS}`);
          return next();
        }
      } else {
        logger.info(`Message not for processing. PayloadType: ${payloadType}, ToChain: ${toChain}`);
        return next();
      }
    },
  );

  await app.listen();
})();
