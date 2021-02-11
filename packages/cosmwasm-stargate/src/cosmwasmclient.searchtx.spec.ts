/* eslint-disable @typescript-eslint/naming-convention */
import { fromBase64, toBase64 } from "@cosmjs/encoding";
import { Coin, coins } from "@cosmjs/launchpad";
import {
  DirectSecp256k1HdWallet,
  encodePubkey,
  makeAuthInfoBytes,
  makeSignDoc,
  Registry,
} from "@cosmjs/proto-signing";
import { BroadcastTxResponse, isBroadcastTxFailure, isBroadcastTxSuccess } from "@cosmjs/stargate";
import { Tx, TxRaw } from "@cosmjs/stargate/build/codec/cosmos/tx/v1beta1/tx";
import { assert, sleep } from "@cosmjs/utils";

import { CosmWasmClient } from "./cosmwasmclient";
import {
  alice,
  fromOneElementArray,
  makeRandomAddress,
  pendingWithoutWasmd,
  wasmd,
  wasmdEnabled,
} from "./testutils.spec";

interface TestTxSend {
  readonly sender: string;
  readonly recipient: string;
  readonly hash: string;
  readonly height: number;
  readonly tx: Uint8Array;
}

async function sendTokens(
  client: CosmWasmClient,
  registry: Registry,
  wallet: DirectSecp256k1HdWallet,
  recipient: string,
  amount: readonly Coin[],
  memo: string,
): Promise<{
  readonly broadcastResponse: BroadcastTxResponse;
  readonly tx: Uint8Array;
}> {
  const [{ address: walletAddress, pubkey: pubkeyBytes }] = await wallet.getAccounts();
  const pubkey = encodePubkey({
    type: "tendermint/PubKeySecp256k1",
    value: toBase64(pubkeyBytes),
  });
  const txBodyFields = {
    typeUrl: "/cosmos.tx.v1beta1.TxBody",
    value: {
      messages: [
        {
          typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          value: {
            fromAddress: walletAddress,
            toAddress: recipient,
            amount: amount,
          },
        },
      ],
      memo: memo,
    },
  };
  const txBodyBytes = registry.encode(txBodyFields);
  const { accountNumber, sequence } = (await client.getSequence(walletAddress))!;
  const feeAmount = [
    {
      amount: "2000",
      denom: "ucosm",
    },
  ];
  const gasLimit = 200000;
  const authInfoBytes = makeAuthInfoBytes([pubkey], feeAmount, gasLimit, sequence);

  const chainId = await client.getChainId();
  const signDoc = makeSignDoc(txBodyBytes, authInfoBytes, chainId, accountNumber);
  const { signature } = await wallet.signDirect(walletAddress, signDoc);
  const txRaw = TxRaw.fromPartial({
    bodyBytes: txBodyBytes,
    authInfoBytes: authInfoBytes,
    signatures: [fromBase64(signature.signature)],
  });
  const txRawBytes = Uint8Array.from(TxRaw.encode(txRaw).finish());
  const broadcastResponse = await client.broadcastTx(txRawBytes);
  return {
    broadcastResponse: broadcastResponse,
    tx: txRawBytes,
  };
}

describe("CosmWasmClient.getTx and .searchTx", () => {
  const registry = new Registry();

  let sendUnsuccessful: TestTxSend | undefined;
  let sendSuccessful: TestTxSend | undefined;

  beforeAll(async () => {
    if (wasmdEnabled()) {
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(alice.mnemonic, undefined, wasmd.prefix);
      const client = await CosmWasmClient.connect(wasmd.endpoint);
      const unsuccessfulRecipient = makeRandomAddress();
      const successfulRecipient = makeRandomAddress();

      const unsuccessfulResult = await sendTokens(
        client,
        registry,
        wallet,
        unsuccessfulRecipient,
        coins(123456700000000, "ucosm"),
        "Sending more than I can afford",
      );
      if (isBroadcastTxFailure(unsuccessfulResult.broadcastResponse)) {
        sendUnsuccessful = {
          sender: alice.address0,
          recipient: unsuccessfulRecipient,
          hash: unsuccessfulResult.broadcastResponse.transactionHash,
          height: unsuccessfulResult.broadcastResponse.height,
          tx: unsuccessfulResult.tx,
        };
      }
      const successfulResult = await sendTokens(
        client,
        registry,
        wallet,
        successfulRecipient,
        coins(1234567, "ucosm"),
        "Something I can afford",
      );
      if (isBroadcastTxSuccess(successfulResult.broadcastResponse)) {
        sendSuccessful = {
          sender: alice.address0,
          recipient: successfulRecipient,
          hash: successfulResult.broadcastResponse.transactionHash,
          height: successfulResult.broadcastResponse.height,
          tx: successfulResult.tx,
        };
      }

      await sleep(75); // wait until transactions are indexed
    }
  });

  describe("getTx", () => {
    it("can get successful tx by ID", async () => {
      pendingWithoutWasmd();
      assert(sendSuccessful, "value must be set in beforeAll()");
      const client = await CosmWasmClient.connect(wasmd.endpoint);
      const result = await client.getTx(sendSuccessful.hash);
      expect(result).toEqual(
        jasmine.objectContaining({
          height: sendSuccessful.height,
          hash: sendSuccessful.hash,
          code: 0,
          tx: sendSuccessful.tx,
        }),
      );
    });

    it("can get unsuccessful tx by ID", async () => {
      pendingWithoutWasmd();
      assert(sendUnsuccessful, "value must be set in beforeAll()");
      const client = await CosmWasmClient.connect(wasmd.endpoint);
      const result = await client.getTx(sendUnsuccessful.hash);
      expect(result).toEqual(
        jasmine.objectContaining({
          height: sendUnsuccessful.height,
          hash: sendUnsuccessful.hash,
          code: 5,
          tx: sendUnsuccessful.tx,
        }),
      );
    });

    it("can get by ID (non existent)", async () => {
      pendingWithoutWasmd();
      const client = await CosmWasmClient.connect(wasmd.endpoint);
      const nonExistentId = "0000000000000000000000000000000000000000000000000000000000000000";
      const result = await client.getTx(nonExistentId);
      expect(result).toBeNull();
    });
  });

  describe("with SearchByHeightQuery", () => {
    it("can search successful tx by height", async () => {
      pendingWithoutWasmd();
      assert(sendSuccessful, "value must be set in beforeAll()");
      const client = await CosmWasmClient.connect(wasmd.endpoint);
      const result = await client.searchTx({ height: sendSuccessful.height });
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result).toContain(
        jasmine.objectContaining({
          height: sendSuccessful.height,
          hash: sendSuccessful.hash,
          code: 0,
          tx: sendSuccessful.tx,
        }),
      );
    });

    it("can search unsuccessful tx by height", async () => {
      pendingWithoutWasmd();
      assert(sendUnsuccessful, "value must be set in beforeAll()");
      const client = await CosmWasmClient.connect(wasmd.endpoint);
      const result = await client.searchTx({ height: sendUnsuccessful.height });
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result).toContain(
        jasmine.objectContaining({
          height: sendUnsuccessful.height,
          hash: sendUnsuccessful.hash,
          code: 5,
          tx: sendUnsuccessful.tx,
        }),
      );
    });
  });

  describe("with SearchBySentFromOrToQuery", () => {
    it("can search by sender", async () => {
      pendingWithoutWasmd();
      assert(sendSuccessful, "value must be set in beforeAll()");
      const client = await CosmWasmClient.connect(wasmd.endpoint);
      const results = await client.searchTx({ sentFromOrTo: sendSuccessful.sender });
      expect(results.length).toBeGreaterThanOrEqual(1);

      // Check basic structure of all results
      for (const result of results) {
        const tx = Tx.decode(result.tx);
        const filteredMsgs = tx.body!.messages.filter(({ typeUrl: typeUrl, value }) => {
          if (typeUrl !== "/cosmos.bank.v1beta1.MsgSend") return false;
          const decoded = registry.decode({ typeUrl: typeUrl, value: value });
          return decoded.fromAddress === sendSuccessful?.sender;
        });
        expect(filteredMsgs.length).toBeGreaterThanOrEqual(1);
      }

      // Check details of most recent result
      expect(results[results.length - 1]).toEqual(
        jasmine.objectContaining({
          height: sendSuccessful.height,
          hash: sendSuccessful.hash,
          tx: sendSuccessful.tx,
        }),
      );
    });

    it("can search by recipient", async () => {
      pendingWithoutWasmd();
      assert(sendSuccessful, "value must be set in beforeAll()");
      const client = await CosmWasmClient.connect(wasmd.endpoint);
      const results = await client.searchTx({ sentFromOrTo: sendSuccessful.recipient });
      expect(results.length).toBeGreaterThanOrEqual(1);

      // Check basic structure of all results
      for (const result of results) {
        const tx = Tx.decode(result.tx);
        const filteredMsgs = tx.body!.messages.filter(({ typeUrl: typeUrl, value }) => {
          if (typeUrl !== "/cosmos.bank.v1beta1.MsgSend") return false;
          const decoded = registry.decode({ typeUrl: typeUrl, value: value });
          return decoded.toAddress === sendSuccessful?.recipient;
        });
        expect(filteredMsgs.length).toBeGreaterThanOrEqual(1);
      }

      // Check details of most recent result
      expect(results[results.length - 1]).toEqual(
        jasmine.objectContaining({
          height: sendSuccessful.height,
          hash: sendSuccessful.hash,
          tx: sendSuccessful.tx,
        }),
      );
    });

    it("can search by recipient and filter by minHeight", async () => {
      pendingWithoutWasmd();
      assert(sendSuccessful);
      const client = await CosmWasmClient.connect(wasmd.endpoint);
      const query = { sentFromOrTo: sendSuccessful.recipient };

      {
        const result = await client.searchTx(query, { minHeight: 0 });
        expect(result.length).toEqual(1);
      }

      {
        const result = await client.searchTx(query, { minHeight: sendSuccessful.height - 1 });
        expect(result.length).toEqual(1);
      }

      {
        const result = await client.searchTx(query, { minHeight: sendSuccessful.height });
        expect(result.length).toEqual(1);
      }

      {
        const result = await client.searchTx(query, { minHeight: sendSuccessful.height + 1 });
        expect(result.length).toEqual(0);
      }
    });

    it("can search by recipient and filter by maxHeight", async () => {
      pendingWithoutWasmd();
      assert(sendSuccessful);
      const client = await CosmWasmClient.connect(wasmd.endpoint);
      const query = { sentFromOrTo: sendSuccessful.recipient };

      {
        const result = await client.searchTx(query, { maxHeight: 9999999999999 });
        expect(result.length).toEqual(1);
      }

      {
        const result = await client.searchTx(query, { maxHeight: sendSuccessful.height + 1 });
        expect(result.length).toEqual(1);
      }

      {
        const result = await client.searchTx(query, { maxHeight: sendSuccessful.height });
        expect(result.length).toEqual(1);
      }

      {
        const result = await client.searchTx(query, { maxHeight: sendSuccessful.height - 1 });
        expect(result.length).toEqual(0);
      }
    });
  });

  describe("with SearchByTagsQuery", () => {
    it("can search by transfer.recipient", async () => {
      pendingWithoutWasmd();
      assert(sendSuccessful, "value must be set in beforeAll()");
      const client = await CosmWasmClient.connect(wasmd.endpoint);
      const results = await client.searchTx({
        tags: [{ key: "transfer.recipient", value: sendSuccessful.recipient }],
      });
      expect(results.length).toBeGreaterThanOrEqual(1);

      // Check basic structure of all results
      for (const result of results) {
        const tx = Tx.decode(result.tx);
        const { typeUrl, value } = fromOneElementArray(tx.body!.messages);
        expect(typeUrl).toEqual("/cosmos.bank.v1beta1.MsgSend");
        const decoded = registry.decode({ typeUrl: typeUrl, value: value });
        expect(decoded.toAddress).toEqual(sendSuccessful.recipient);
      }

      // Check details of most recent result
      expect(results[results.length - 1]).toEqual(
        jasmine.objectContaining({
          height: sendSuccessful.height,
          hash: sendSuccessful.hash,
          tx: sendSuccessful.tx,
        }),
      );
    });
  });
});