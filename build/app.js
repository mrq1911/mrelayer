"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const relayer_engine_1 = require("@wormhole-foundation/relayer-engine");
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
const winston = require("winston");
const logger = winston.createLogger({
    transports: [
        new winston.transports.Console({
            level: process.env.LOG_LEVEL || "info"
        }),
    ],
    format: winston.format.combine(winston.format.colorize(), winston.format.splat(), winston.format.simple(), winston.format.timestamp({
        format: "YYYY-MM-DD HH:mm:ss.SSS",
    }), winston.format.errors({ stack: true })),
});
(async function main() {
    // initialize relayer engine app, pass relevant config options
    const app = new relayer_engine_1.StandardRelayerApp(relayer_engine_1.Environment.MAINNET, 
    // other app specific config options can be set here for things
    // like retries, logger, or redis connection settings.
    {
        name: `mrelayer4`,
        logger,
        missedVaaOptions: {
            startingSequenceConfig: {
                [wormhole_sdk_1.CHAIN_ID_ACALA]: BigInt(2600),
                [wormhole_sdk_1.CHAIN_ID_ETH]: BigInt(268000),
            }
        }
    });
    const MRL_ADDRESS = "0000000000000000000000000000000000000000000000000000000000000816";
    // add a filter with a callback that will be
    // invoked on finding a VAA that matches the filter
    app.tokenBridge([wormhole_sdk_1.CHAIN_ID_ACALA, wormhole_sdk_1.CHAIN_ID_ETH], async (ctx, next) => {
        const { payload } = ctx.tokenBridge;
        const { vaa } = ctx;
        const { payloadType, toChain } = payload;
        const to = payload.to.toString("hex");
        if (toChain === wormhole_sdk_1.CHAIN_ID_MOONBEAM
            && payloadType === wormhole_sdk_1.TokenBridgePayload.TransferWithPayload
            && to === MRL_ADDRESS) {
            ctx.logger.info(`Transfer processing for: \n` +
                `\tToken: ${payload.tokenChain}:${payload.tokenAddress.toString("hex")}\n` +
                `\tAmount: ${payload.amount}\n` +
                `\tSender ${payload.fromAddress?.toString("hex")}\n` +
                `\tReceiver: ${payload.toChain}:${payload.to.toString("hex")}\n` +
                `\tPayload: ${payload.tokenTransferPayload.toString("hex")}\n`);
        }
        next();
    });
    // start app, blocks until unrecoverable error or process is stopped
    await app.listen();
})();
//# sourceMappingURL=app.js.map