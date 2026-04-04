"use client";

/**
 * @fileoverview Meshtastic Serial Boilerplate Component
 * @description A React component for connecting to Meshtastic devices via Web Serial API.
 * Provides functionality for:
 * - Serial connection management
 * - Channel PSK configuration (Primary and Secondary)
 * - Message sending and receiving
 *
 * @requires @meshtastic/core
 * @requires @meshtastic/transport-web-serial
 * @requires @meshtastic/protobufs
 * @requires @bufbuild/protobuf
 */

// Polyfill for util.formatWithOptions if not available
import util from "util";


if (!util.formatWithOptions) {
  util.formatWithOptions = function (inspectOptions, format, ...args) {
    return util.format ? util.format(format, ...args) : format;
  };
}

import { useState, useEffect } from "react";
import {
  Button,
  TextInput,
  NativeSelect,
  Group,
  Stack,
  Paper,
  Title,
  Text,
  Code,
} from "@mantine/core";
import { MeshDevice, Types } from "@meshtastic/core";
import { TransportWebSerial } from "@meshtastic/transport-web-serial";
import { Channel as ChannelProto } from "@meshtastic/protobufs";
import { create } from "@bufbuild/protobuf";
import { encodeAbiParameters, keccak256 } from "viem";
import { getCurrentChainId, getEvvmSigner } from "@/app/utils/evvm-signer";
import { Core } from "@evvm/evvm-js";
import contractAddress from "@/constants/contractAddress.json";

/**
 * Available PSK (Pre-Shared Key) size options for channel encryption.
 * - `none`: No encryption (0 bytes)
 * - `8bit`: Simple encryption (1 byte) - minimal security
 * - `128bit`: AES-128 encryption (16 bytes)
 * - `256bit`: AES-256 encryption (32 bytes) - recommended
 */
type PSKSize = "none" | "8bit" | "128bit" | "256bit";

/**
 * Represents a received message from the mesh network.
 */
interface MeshMessage {
  /** Channel index the message was received on */
  channel: number;
  /** Node ID of the sender */
  from: number | string;
  /** Text content of the message */
  text: string;
  /** Unix timestamp when the message was received */
  timestamp: number;
  /** Source event that captured the message (optional) */
  source?: string;
}

interface SendToEvvmField {
  to: string;
  from: string;
  identity: string;
  token: string;
  amount: string;
  priorityFee: string;
  executor: string;
  addr7: string;
  nonce: string;
  isAsyncExec: boolean;
  signature: string;
}

interface CctpField {
  destinationChain: string;
  amount: string;
  nonce: string;
  isAsyncExec: boolean;
  signature: string;
  priorityFeeEvvm: string;
  nonceEvvm: string;
  isAsyncExecEvvm: boolean;
  signatureEvvm: string;
}

interface ActionRecord {
  action: string;
  field: SendToEvvmField | CctpField | Record<string, any>;
  from: number | string;
  channel: number;
  timestamp: number;
}

/**
 * Generates a random PSK (Pre-Shared Key) of the specified size.
 * Uses the Web Crypto API for cryptographically secure random values.
 *
 * @param size - The desired PSK size
 * @returns A Uint8Array containing the generated PSK
 *
 * @example
 * ```typescript
 * const psk256 = generatePSK('256bit') // 32 bytes
 * const psk128 = generatePSK('128bit') // 16 bytes
 * const noPsk = generatePSK('none')    // 0 bytes
 * ```
 */
function generatePSK(size: PSKSize): Uint8Array {
  switch (size) {
    case "none":
      return new Uint8Array(0);
    case "8bit":
      return crypto.getRandomValues(new Uint8Array(1));
    case "128bit":
      return crypto.getRandomValues(new Uint8Array(16));
    case "256bit":
      return crypto.getRandomValues(new Uint8Array(32));
  }
}

/**
 * Converts a Uint8Array to a Base64-encoded string.
 *
 * @param arr - The Uint8Array to convert
 * @returns Base64-encoded string representation
 *
 * @example
 * ```typescript
 * const psk = new Uint8Array([1, 2, 3, 4])
 * const base64 = uint8ArrayToBase64(psk) // "AQIDBA=="
 * ```
 */
function uint8ArrayToBase64(arr: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

const ZERO_ADDR = "0000000000000000000000000000000000000000";

const CCTP_CHAIN_CODE: Record<string, string> = {
  ethereum_sepolia: "E",
  arbitrum_sepolia: "A",
};
const CCTP_CHAIN_NAME: Record<string, string> = {
  E: "ethereum_sepolia",
  A: "arbitrum_sepolia",
};

/**
 * Encodes CCTP executeCrosschain call data into a compact Meshtastic string.
 * Format: c=chain|amount|nonce|ia|sig|pfee|nonceEvvm|iaEvvm|sigEvvm
 * Chain codes: E=ethereum_sepolia, A=arbitrum_sepolia. Sigs in base64 (no padding).
 */
function encodeCctpArgs(
  destinationChain: string,
  amount: string,
  nonce: string,
  isAsyncExec: boolean,
  crosschainSig: string,
  priorityFeeEvvm: string,
  nonceEvvm: string,
  isAsyncExecEvvm: boolean,
  evvmSig: string
): string {
  const sigToB64 = (hex: string) => {
    const h = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(h.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    }
    return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
  };
  return "c=" + [
    CCTP_CHAIN_CODE[destinationChain] ?? destinationChain,
    amount,
    nonce,
    isAsyncExec ? "1" : "0",
    sigToB64(crosschainSig),
    priorityFeeEvvm,
    nonceEvvm,
    isAsyncExecEvvm ? "1" : "0",
    sigToB64(evvmSig),
  ].join("|");
}

/**
 * Decodes a compact CCTP Meshtastic string (after stripping "c=") back into CctpField.
 */
function decodeCctpArgs(encoded: string): CctpField {
  const parts = encoded.split("|");
  const b64ToHex = (b64: string) => {
    const binary = atob(b64);
    let hex = "0x";
    for (let i = 0; i < binary.length; i++) {
      hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return hex;
  };
  return {
    destinationChain: CCTP_CHAIN_NAME[parts[0]] ?? parts[0],
    amount: parts[1],
    nonce: parts[2],
    isAsyncExec: parts[3] === "1",
    signature: b64ToHex(parts[4]),
    priorityFeeEvvm: parts[5],
    nonceEvvm: parts[6],
    isAsyncExecEvvm: parts[7] === "1",
    signatureEvvm: b64ToHex(parts[8]),
  };
}

/**
 * Encodes EVVM signed action args into a compact string for Meshtastic.
 * Format: s=to|from|amount|fee|nonce|async|sig
 * - Strips "0x" prefixes
 * - Zero addresses become "Z"
 * - identity omitted (always empty), token/executor/addr7 omitted (always address(0))
 * - Signature hex is converted to base64
 * - Booleans become "1"/"0"
 */
function encodeArgs(args: any[]): string {
  const strip = (v: string) => v.startsWith("0x") ? v.slice(2) : v;
  const addr = (v: string) => {
    const raw = strip(v);
    return raw === ZERO_ADDR ? "Z" : raw;
  };
  const sigHex = strip(String(args[10]));
  const sigBytes = new Uint8Array(sigHex.length / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
  }
  const sigB64 = btoa(String.fromCharCode(...sigBytes));

  return [
    addr(String(args[0])),  // to
    addr(String(args[1])),  // from
    String(args[4]),        // amount
    String(args[5]),        // priorityFee
    String(args[8]),        // nonce
    args[9] ? "1" : "0",   // isAsyncExec
    sigB64,                 // signature
  ].join("|");
}

/**
 * Decodes a compact Meshtastic string back into the original EVVM args array.
 * Reverses encodeArgs: restores "0x" prefixes, expands "Z" to zero address,
 * re-inserts identity (empty), token/executor/addr7 as address(0),
 * converts base64 signature back to hex, and restores boolean.
 */
function decodeArgs(encoded: string): SendToEvvmField {
  const ZERO_FULL = "0x" + ZERO_ADDR;
  const parts = encoded.split("|");
  const restoreAddr = (v: string) => v === "Z" ? ZERO_FULL : "0x" + v;

  // Decode base64 signature back to hex
  const sigBinary = atob(parts[6]);
  let sigHex = "0x";
  for (let i = 0; i < sigBinary.length; i++) {
    sigHex += sigBinary.charCodeAt(i).toString(16).padStart(2, "0");
  }

  return {
    to: restoreAddr(parts[0]),
    from: restoreAddr(parts[1]),
    identity: "",
    token: ZERO_FULL,
    amount: parts[2],
    priorityFee: parts[3],
    executor: ZERO_FULL,
    addr7: ZERO_FULL,
    nonce: parts[4],
    isAsyncExec: parts[5] === "1",
    signature: sigHex,
  };
}

/**
 * Meshtastic Serial Boilerplate Component.
 *
 * A comprehensive React component for interacting with Meshtastic devices
 * through the Web Serial API. Supports connection management, channel
 * configuration with PSK encryption, and bidirectional messaging.
 *
 * @remarks
 * This component requires a browser that supports the Web Serial API
 * (Chrome, Edge, or other Chromium-based browsers).
 *
 * @example
 * ```tsx
 * import MshtasticBoilerplate from '@/components/mshtasticBoilerplate'
 *
 * export default function Page() {
 *   return <MshtasticBoilerplate />
 * }
 * ```
 *
 * @returns The rendered Meshtastic boilerplate UI
 */
export default function MshtasticBoilerplate() {
  // ============================================
  // State Variables
  // ============================================

  /** Mesh device instance for communication */
  const [device, setDevice] = useState<MeshDevice | null>(null);

  /** Current connection status */
  const [isConnected, setIsConnected] = useState(false);

  /** Array of received messages */
  const [messages, setMessages] = useState<MeshMessage[]>([]);

  /** Queue of decoded action records (persisted in localStorage) */
  const [actionQueue, setActionQueue] = useState<ActionRecord[]>([]);

  /** Report of the last process-queue run */
  const [processReport, setProcessReport] = useState<{ timestamp: number; action: string; status: number | "error"; response: any }[] | null>(null);

  /** Whether the queue is currently being processed */
  const [isProcessing, setIsProcessing] = useState(false);

  /** Crosschain (CCTP) signature generated by makeCCTP */
  const [cctpCrosschainSig, setCctpCrosschainSig] = useState("");

  /** EVVM pay signature generated by makeCCTP */
  const [cctpEvvmSig, setCctpEvvmSig] = useState("");

  useEffect(() => {
    try {
      const stored = localStorage.getItem("actionQueue");
      if (stored) {
        setActionQueue(JSON.parse(stored));
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("actionQueue", JSON.stringify(actionQueue));
    } catch (err) {
      console.error("[Mesh] Failed to persist actionQueue:", err);
    }
  }, [actionQueue]);

  /** Primary channel PSK in Base64 format */
  const [primaryPSK, setPrimaryPSK] = useState("");

  /** Selected PSK size for primary channel */
  const [primaryPSKSize, setPrimaryPSKSize] = useState<PSKSize>("256bit");

  /** Secondary channel PSK in Base64 format */
  const [secondaryPSK, setSecondaryPSK] = useState("");

  /** Selected PSK size for secondary channel */
  const [secondaryPSKSize, setSecondaryPSKSize] = useState<PSKSize>("256bit");

  /** Text message to send */
  const [messageText, setMessageText] = useState("");

  /** Selected channel index for sending messages (0 = Primary, 1 = Secondary) */
  const [channel, setChannel] = useState(0);

  // ============================================
  // Connection Functions
  // ============================================

  /**
   * Establishes a serial connection to a Meshtastic device.
   *
   * Opens a browser dialog to select the serial port, creates the transport
   * and device instances, and sets up event listeners for device status
   * and incoming messages.
   *
   * @async
   * @throws {Error} If the connection fails or user cancels port selection
   *
   * @remarks
   * Subscribes to two message events:
   * - `onMessagePacket`: Captures sent messages (echo)
   * - `onTextPacket`: Captures received messages from other devices
   */
  async function connect() {
    try {
      const transport = await TransportWebSerial.create();
      const meshDevice = new MeshDevice(transport);

      // Track device status and trigger configure handshake
      meshDevice.events.onDeviceStatus.subscribe((status: any) => {
        console.warn(
          "[Mesh] Status:",
          Types.DeviceStatusEnum[status],
          `(${status})`,
        );
        if (status === Types.DeviceStatusEnum.DeviceConnected) {
          meshDevice
            .configure()
            .then(() => {
              console.warn("[Mesh] configure() ack received");
            })
            .catch((err) => {
              console.error("[Mesh] configure() failed:", err);
            });
        }
        if (status === Types.DeviceStatusEnum.DeviceConfigured) {
          console.warn("[Mesh] Device fully configured — starting heartbeat");
          meshDevice.setHeartbeatInterval(300_000); // 5 min keepalive
          setIsConnected(true);
        }
        if (status === Types.DeviceStatusEnum.DeviceDisconnected) {
          setIsConnected(false);
        }
      });

      // Monitor ALL FromRadio frames (config, packets, etc.)
      meshDevice.events.onFromRadio.subscribe((fromRadio: any) => {
        console.warn("[Mesh] FromRadio:", fromRadio.payloadVariant.case);
      });

      // Monitor every MeshPacket: decoded vs encrypted
      meshDevice.events.onMeshPacket.subscribe((meshPacket: any) => {
        console.warn(
          "[Mesh] MeshPacket:",
          meshPacket.payloadVariant.case,
          "from:",
          meshPacket.from,
          "to:",
          meshPacket.to,
        );
      });

      // RF activity indicator
      meshDevice.events.onMeshHeartbeat.subscribe((date: any) => {
        console.warn(
          "[Mesh] RF heartbeat (mesh activity detected):",
          date.toLocaleTimeString(),
        );
      });

      // TEXT_MESSAGE_APP packets — the actual messages
      meshDevice.events.onMessagePacket.subscribe((packet: any) => {
        console.warn("[Mesh] onMessagePacket:", packet);
        const text: string = packet.data;

        if (text.startsWith("s=")) {
          try {
            const decoded = decodeArgs(text.slice(2));
            console.log("[Mesh] Decoded EVVM args:", decoded);
            const record: ActionRecord = {
              action: "sendToEvvm",
              field: decoded,
              from: packet.from,
              channel: packet.channel,
              timestamp: Date.now(),
            };
            setActionQueue((prev) => [...prev, record]);
            setMessages((prev) => [
              ...prev,
              {
                channel: packet.channel,
                from: packet.from,
                text: "[sendToEvvm] " + JSON.stringify(decoded),
                timestamp: Date.now(),
                source: "evvm",
              },
            ]);
          } catch (err) {
            console.error("[Mesh] Failed to decode EVVM message:", err);
            setMessages((prev) => [
              ...prev,
              {
                channel: packet.channel,
                from: packet.from,
                text: text,
                timestamp: Date.now(),
              },
            ]);
          }
        } else if (text.startsWith("c=")) {
          try {
            const decoded = decodeCctpArgs(text.slice(2));
            console.log("[Mesh] Decoded CCTP args:", decoded);
            const record: ActionRecord = {
              action: "executeCrosschain",
              field: decoded,
              from: packet.from,
              channel: packet.channel,
              timestamp: Date.now(),
            };
            setActionQueue((prev) => [...prev, record]);
            setMessages((prev) => [
              ...prev,
              {
                channel: packet.channel,
                from: packet.from,
                text: "[executeCrosschain] " + JSON.stringify(decoded),
                timestamp: Date.now(),
                source: "cctp",
              },
            ]);
          } catch (err) {
            console.error("[Mesh] Failed to decode CCTP message:", err);
            setMessages((prev) => [
              ...prev,
              {
                channel: packet.channel,
                from: packet.from,
                text: text,
                timestamp: Date.now(),
              },
            ]);
          }
        } else {
          setMessages((prev) => [
            ...prev,
            {
              channel: packet.channel,
              from: packet.from,
              text: text,
              timestamp: Date.now(),
            },
          ]);
        }
      });

      setDevice(meshDevice);
    } catch (error) {
      console.error("Connection failed:", error);
    }
  }

  /**
   * Disconnects from the currently connected Meshtastic device.
   * Cleans up the device instance and resets connection state.
   */
  function disconnect() {
    if (device) {
      device.disconnect();
      setDevice(null);
      setIsConnected(false);
    }
  }

  // ============================================
  // PSK Generation Functions
  // ============================================

  /**
   * Generates a new PSK for the primary channel based on the selected size.
   * Updates the primaryPSK state with the Base64-encoded value.
   */
  function generatePrimaryPSK() {
    const psk = generatePSK(primaryPSKSize);
    setPrimaryPSK(uint8ArrayToBase64(psk));
  }

  /**
   * Generates a new PSK for the secondary channel based on the selected size.
   * Updates the secondaryPSK state with the Base64-encoded value.
   */
  function generateSecondaryPSK() {
    const psk = generatePSK(secondaryPSKSize);
    setSecondaryPSK(uint8ArrayToBase64(psk));
  }

  // ============================================
  // Channel Configuration Functions
  // ============================================

  /**
   * Configures the primary channel (index 0) with the specified PSK.
   *
   * If a PSK is provided in the input field, it will be used.
   * Otherwise, a new PSK will be generated based on the selected size.
   *
   * @async
   * @throws {Error} If the channel configuration fails
   */
  async function setupPrimaryPSK() {
    if (!device) return;

    try {
      let psk: Uint8Array;

      if (primaryPSK) {
        // Use provided Base64 PSK
        const binaryString = atob(primaryPSK);
        psk = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          psk[i] = binaryString.charCodeAt(i);
        }
      } else {
        // Generate new PSK based on selected size
        psk = generatePSK(primaryPSKSize);
        setPrimaryPSK(uint8ArrayToBase64(psk));
      }

      const channelConfig = create(ChannelProto.ChannelSchema, {
        index: 0,
        role: ChannelProto.Channel_Role.PRIMARY,
        settings: {
          psk: psk,
          name: "Primary",
        },
      });

      await device.setChannel(channelConfig);

      alert("Primary PSK set");
    } catch (error) {
      console.error("Failed to set primary PSK:", error);
    }
  }

  /**
   * Configures the secondary channel (index 1) with the specified PSK.
   *
   * If a PSK is provided in the input field, it will be used.
   * Otherwise, a new PSK will be generated based on the selected size.
   *
   * @async
   * @throws {Error} If the channel configuration fails
   */
  async function setupSecondaryPSK() {
    if (!device) return;

    try {
      let psk: Uint8Array;

      if (secondaryPSK) {
        // Use provided Base64 PSK
        const binaryString = atob(secondaryPSK);
        psk = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          psk[i] = binaryString.charCodeAt(i);
        }
      } else {
        // Generate new PSK based on selected size
        psk = generatePSK(secondaryPSKSize);
        setSecondaryPSK(uint8ArrayToBase64(psk));
      }

      const channelConfig = create(ChannelProto.ChannelSchema, {
        index: 1,
        role: ChannelProto.Channel_Role.SECONDARY,
        settings: {
          psk: psk,
          name: "Secondary",
        },
      });

      await device.setChannel(channelConfig);

      alert("Secondary PSK set");
    } catch (error) {
      console.error("Failed to set secondary PSK:", error);
    }
  }

  // ============================================
  // Messaging Functions
  // ============================================

  /**
   * Sends a text message to the mesh network on the selected channel.
   *
   * The message is broadcast to all nodes (destination = undefined).
   * Requests acknowledgment from receiving nodes (wantAck = true).
   *
   * @async
   * @throws {Error} If the message fails to send
   */
  async function sendMessage() {
    if (!device || !messageText) return;

    try {
      await device.sendText(
        messageText,
        undefined, // destination (broadcast)
        true, // wantAck
        channel, // channel index
      );

      setMessageText("");
      //alert(`Message sent on channel ${channel}`)
    } catch (error) {
      console.error("Failed to send message:", error);
    }
  }

  async function sendTestMessage() {
    if (!device) return;

    try {
      await device.sendText("send test by button", undefined, true, channel);

      alert(`Test message sent on channel ${channel}`);
    } catch (error) {
      console.error("Failed to send test message:", error);
    }
  }

  // ============================================
  // Signature Generation Function (EVVM)
  // ============================================

  const makeSig = async () => {
    const getValue = (id: string) =>
      (document.getElementById(id) as HTMLInputElement)?.value;

    const to = getValue("toAddressInput_Pay");
    const tokenAddress = "0x0000000000000000000000000000000000000000";
    const amount = getValue("amountTokenInput_Pay");
    const priorityFee = getValue("priorityFeeInput_Pay");
    const nonce = getValue("nonceInput_Pay");
    const senderExecutor = "0x0000000000000000000000000000000000000000";

    if (!tokenAddress || !amount || !priorityFee || !nonce) {
      console.error("All fields are required");
      return;
    }

    try {
      const signer = await getEvvmSigner();
      const evvm = new Core({
        signer,
        address: contractAddress.evvmCore as `0x${string}`,
        chainId: getCurrentChainId(),
      });

      let signedAction;

      signedAction = await evvm.pay({
        toAddress: to as `0x${string}`,
        tokenAddress: tokenAddress as `0x${string}`,
        amount: BigInt(amount),
        priorityFee: BigInt(priorityFee),
        nonce: BigInt(nonce),
        isAsyncExec: true,
        senderExecutor: senderExecutor as `0x${string}`,
      });

      const args = signedAction.toJSON().args;
      console.log("Raw args:", args);

      const encoded = "s=" + encodeArgs(args);
      console.log("Encoded length:", encoded.length, "chars");
      console.log("Encoded:", encoded);
      setMessageText(encoded);
    } catch (error) {
      console.error("Error creating signature:", error);
    }
  };

  // ============================================
  // CCTP Crosschain Signature Function
  // ============================================

  const CCTP_TRUSTED_EOA = "0xE2627d04bD2bc7DFcCF5b7D1c2739B13B29ABc33" as `0x${string}`;
  const CCTP_SERVICE_ADDR = "0x166b4207da35740e38e55B09819fdFAdF27401cD" as `0x${string}`;

  const makeCCTP = async () => {
    const getValue = (id: string) =>
      (document.getElementById(id) as HTMLInputElement)?.value;

    const destinationChain = getValue("destinationChainInput_CCTP");
    const amount = getValue("amountInput_CCTP");
    const nonce = getValue("nonceInput_CCTP");
    const priorityFee = getValue("priorityFeeInput_CCTP");
    const nonceEvvm = getValue("nonceEvvmInput_CCTP");

    const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;

    if (!destinationChain || !amount || !nonce || !priorityFee || !nonceEvvm) {
      console.error("[CCTP] All fields are required");
      return;
    }

    try {
      const signer = await getEvvmSigner();
      const evvm = new Core({
        signer,
        address: contractAddress.evvmCore as `0x${string}`,
        chainId: getCurrentChainId(),
      });

      const evvmId = await evvm.getEvvmID();

      // keccak256(abi.encode("executeCrosschain", destinationChain, amount))
      const encodedPayload = encodeAbiParameters(
        [{ type: "string" }, { type: "string" }, { type: "uint256" }],
        ["executeCrosschain", destinationChain, BigInt(amount)]
      );
      const hashPayload = keccak256(encodedPayload) as `0x${string}`;

      // Message format: evvmId,senderExecutor,hashPayload,originExecutor,nonce,isAsyncExec
      const message = evvm.buildMessageToSign(
        evvmId,
        ZERO_ADDR,
        hashPayload,
        CCTP_TRUSTED_EOA,
        BigInt(nonce),
        true
      );

      

      const signature = await signer.signMessage(message);
      setCctpCrosschainSig(signature);
      console.log("[CCTP] Message:", message);
      console.log("[CCTP] Crosschain Signature:", signature);

      // EVVM pay signature
      const signedAction = await evvm.pay({
        toAddress: CCTP_SERVICE_ADDR,
        tokenAddress: ZERO_ADDR,
        amount: BigInt(amount),
        priorityFee: BigInt(priorityFee),
        nonce: BigInt(nonceEvvm),
        isAsyncExec: true,
        originExecutor: CCTP_TRUSTED_EOA,
        senderExecutor: CCTP_SERVICE_ADDR,
      });
      const evvmArgs = signedAction.toJSON().args;
      const evvmSignature = String(evvmArgs[10]);
      setCctpEvvmSig(evvmSignature);
      console.log("[CCTP] EVVM Pay Signature:", evvmSignature);

      const encoded = encodeCctpArgs(
        destinationChain,
        amount,
        nonce,
        true,
        signature,
        priorityFee,
        nonceEvvm,
        true,
        evvmSignature
      );
      console.log("[CCTP] Encoded length:", encoded.length, "chars");
      console.log("[CCTP] Encoded:", encoded);
      setMessageText(encoded);
    } catch (error) {
      console.error("[CCTP] Error creating crosschain signature:", error);
    }
  };

  // ============================================
  // Render
  // ============================================

  return (
    <Stack p="md" >

      {/* Connection Section */}
      <Paper withBorder p="md">
        <Title order={2} mb="sm">Connection</Title>
        <Text>Status: {isConnected ? "Connected" : "Disconnected"}</Text>
        {!isConnected ? (
          <Button onClick={connect} mt="sm">Connect Serial</Button>
        ) : (
          <Button onClick={disconnect} color="red" mt="sm">Disconnect</Button>
        )}
      </Paper>

      {/* Primary Channel Configuration
      <Paper withBorder p="md">
        <Title order={2} mb="sm">Primary Channel (0)</Title>
        <Group align="flex-end" mb="sm">
          <NativeSelect
            label="PSK Size"
            value={primaryPSKSize}
            onChange={(e) => setPrimaryPSKSize(e.target.value as PSKSize)}
            data={[
              { value: "none", label: "None (No encryption)" },
              { value: "8bit", label: "8 bits (Simple)" },
              { value: "128bit", label: "128 bits (AES-128)" },
              { value: "256bit", label: "256 bits (AES-256)" },
            ]}
          />
          <Button onClick={generatePrimaryPSK}>Generate</Button>
        </Group>
        <Group align="flex-end">
          <TextInput
            label="PSK"
            placeholder="Base64 PSK (or generate above)"
            value={primaryPSK}
            onChange={(e) => setPrimaryPSK(e.target.value)}
            style={{ width: "300px" }}
          />
          <Button onClick={setupPrimaryPSK} disabled={!isConnected}>Set Primary PSK</Button>
        </Group>
      </Paper>
       */}

      {/* Secondary Channel Configuration 
      <Paper withBorder p="md">
        <Title order={2} mb="sm">Secondary Channel (1)</Title>
        <Group align="flex-end" mb="sm">
          <NativeSelect
            label="PSK Size"
            value={secondaryPSKSize}
            onChange={(e) => setSecondaryPSKSize(e.target.value as PSKSize)}
            data={[
              { value: "none", label: "None (No encryption)" },
              { value: "8bit", label: "8 bits (Simple)" },
              { value: "128bit", label: "128 bits (AES-128)" },
              { value: "256bit", label: "256 bits (AES-256)" },
            ]}
          />
          <Button onClick={generateSecondaryPSK}>Generate</Button>
        </Group>
        <Group align="flex-end">
          <TextInput
            label="PSK"
            placeholder="Base64 PSK (or generate above)"
            value={secondaryPSK}
            onChange={(e) => setSecondaryPSK(e.target.value)}
            style={{ width: "300px" }}
          />
          <Button onClick={setupSecondaryPSK} disabled={!isConnected}>Set Secondary PSK</Button>
        </Group>
      </Paper>
      */}

      
      {/* EVVM Signature */}
      <Paper withBorder p="md" style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
      }}>
        <Title order={2} mb="sm">Payment execution</Title>
        <Stack>
          <TextInput id="toAddressInput_Pay" placeholder="To Address" label="To Address" style={{
            width:"30vw"
          }} />
          <TextInput id="amountTokenInput_Pay" placeholder="Amount" label="Amount" />
          <TextInput id="priorityFeeInput_Pay" placeholder="Priority Fee (gwei)" label="Priority Fee (gwei)" />
          <TextInput id="nonceInput_Pay" placeholder="Nonce" label="Nonce" />
          <Button onClick={makeSig}>Create Signature</Button>
        </Stack>
      </Paper>

      {/* CCTP Crosschain Signature */}
      <Paper withBorder p="md" style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
      }}>
        <Title order={2} mb="sm">Cross-chain Payment (CCTP)</Title>
        <Stack>
          <NativeSelect
            id="destinationChainInput_CCTP"
            label="Destination Chain"
            style={{ width: "30vw" }}
            data={[
              { value: "ethereum_sepolia", label: "Ethereum Sepolia" },
              { value: "arbitrum_sepolia", label: "Arbitrum Sepolia" },
            ]}
          />
          <TextInput id="amountInput_CCTP" placeholder="Amount" label="Amount" />
          <TextInput id="nonceInput_CCTP" placeholder="Nonce (crosschain)" label="Nonce (crosschain)" />
          <TextInput id="priorityFeeInput_CCTP" placeholder="Priority Fee (EVVM)" label="Priority Fee (EVVM)" />
          <TextInput id="nonceEvvmInput_CCTP" placeholder="Nonce (EVVM)" label="Nonce (EVVM)" />
          <Button onClick={makeCCTP}>Create CCTP Signature</Button>
          {cctpCrosschainSig && (
            <Text size="sm" style={{ wordBreak: "break-all" }}>
              <strong>Crosschain Sig:</strong> {cctpCrosschainSig}
            </Text>
          )}
          {cctpEvvmSig && (
            <Text size="sm" style={{ wordBreak: "break-all" }}>
              <strong>EVVM Pay Sig:</strong> {cctpEvvmSig}
            </Text>
          )}
        </Stack>
      </Paper>

      {/* Send Message Section */}
      <Paper withBorder p="md">
        <Title order={2} mb="sm">Send Message</Title>
        <Group align="flex-end" 
          style={{
            flexDirection: "column",
            alignItems: "stretch",
          }}
        >
          {/*<NativeSelect
            label="Channel"
            value={String(channel)}
            onChange={(e) => setChannel(Number(e.target.value))}
            data={[
              { value: "0", label: "Primary (0)" },
              { value: "1", label: "Secondary (1)" },
            ]}
          />*/}
          <TextInput
            label="Message"
            placeholder="Message"
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            
          />
          <Button onClick={sendMessage} disabled={!isConnected}>Send</Button>
        </Group>
      </Paper>

      {/* Action Queue (localStorage) */}
      <Paper withBorder p="md">
        <Title order={2} mb="sm">Action Queue (localStorage)</Title>
        <Group mb="sm">
          <Button
            disabled={isProcessing || actionQueue.length === 0}
            loading={isProcessing}
            onClick={async () => {
              setIsProcessing(true);
              setProcessReport(null);
              const snapshot = [...actionQueue];
              const report: { timestamp: number; action: string; status: number | "error"; response: any }[] = [];
              for (const record of snapshot) {
                try {
                  const endpoint = record.action === "executeCrosschain" ? "/api/executeCrosschain" : "/api/sendToEvvm";
                  const res = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(record.field),
                  });
                  const data = await res.json();
                  console.log(`[Queue] ${record.action} @ ${record.timestamp} → ${res.status}`, data);
                  report.push({ timestamp: record.timestamp, action: record.action, status: res.status, response: data });
                  setActionQueue((prev) => prev.filter((r) => r.timestamp !== record.timestamp));
                } catch (err) {
                  console.error(`[Queue] ${record.action} @ ${record.timestamp} failed:`, err);
                  report.push({ timestamp: record.timestamp, action: record.action, status: "error", response: String(err) });
                }
              }
              setProcessReport(report);
              setIsProcessing(false);
            }}
          >
            {isProcessing ? "Processing..." : `Process Queue (${actionQueue.length})`}
          </Button>
          <Button
            variant="outline"
            color="red"
            disabled={isProcessing}
            onClick={() => setActionQueue([])}
          >
            Clear Queue
          </Button>
        </Group>

        {/* Process Report */}
        {processReport && (
          <Paper withBorder p="sm" mb="sm">
            <Group justify="space-between" mb="xs">
              <Text fw={600}>Process Report ({processReport.length} items)</Text>
              <Button size="xs" variant="subtle" onClick={() => setProcessReport(null)}>Dismiss</Button>
            </Group>
            <Stack gap="xs">
              {processReport.map((entry, i) => (
                <Paper
                  key={i}
                  p="xs"
                  style={{
                    borderLeft: `4px solid ${
                      typeof entry.status === "number" && entry.status >= 200 && entry.status < 300
                        ? "#22c55e"
                        : "#ef4444"
                    }`,
                  }}
                >
                  <Text size="sm">
                    <strong>{entry.action}</strong> — Status: <Code>{entry.status}</Code> — {new Date(entry.timestamp).toLocaleTimeString()}
                  </Text>
                  <details style={{ marginTop: "4px" }}>
                    <summary style={{ fontSize: "12px", cursor: "pointer" }}>Response</summary>
                    <pre style={{ fontSize: "11px", margin: "4px 0 0", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {JSON.stringify(entry.response, null, 2)}
                    </pre>
                  </details>
                </Paper>
              ))}
            </Stack>
          </Paper>
        )}

        {actionQueue.length === 0 ? (
          <Text c="dimmed">No actions stored</Text>
        ) : (
          <Stack gap="sm">
            {actionQueue.map((record, i) => (
              <Paper
                key={i}
                withBorder
                p="sm"
                style={{ borderLeft: "4px solid #228be6" }}
              >
                <Text size="sm"><strong>Action:</strong> {record.action}</Text>
                <Text size="sm" style={{ wordBreak: "break-all" }}><strong>From:</strong> {record.from}</Text>
                <Text size="sm"><strong>Channel:</strong> {record.channel}</Text>
                <Text size="sm"><strong>Time:</strong> {new Date(record.timestamp).toLocaleString()}</Text>
                <details style={{ marginTop: "8px" }}>
                  <summary style={{ fontSize: "12px", cursor: "pointer" }}>Field data ({Object.keys(record.field).length} fields)</summary>
                  <pre
                    style={{
                      background: "#f5f5f5",
                      padding: "8px",
                      borderRadius: "4px",
                      overflow: "auto",
                      fontSize: "12px",
                      marginTop: "4px",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                    }}
                  >
                    {JSON.stringify(record.field, null, 2)}
                  </pre>
                </details>
              </Paper>
            ))}
          </Stack>
        )}
      </Paper>

      {/* Messages Display Section */}
      <Paper withBorder p="md">
        <Title order={2} mb="sm">Messages</Title>
        {messages.length === 0 ? (
          <Text c="dimmed">No messages</Text>
        ) : (
          <Stack gap="sm">
            {messages.map((msg, i) => (
              <Paper key={i} withBorder p="sm">
                <Text size="sm">Channel: {msg.channel}</Text>
                <Text size="sm" style={{ wordBreak: "break-all" }}>From: {msg.from}</Text>
                <Text size="sm" style={{ wordBreak: "break-word", whiteSpace: "pre-wrap" }}>Text: {msg.text}</Text>
                <Text size="sm">Time: {new Date(msg.timestamp).toLocaleString()}</Text>
              </Paper>
            ))}
          </Stack>
        )}
      </Paper>
    </Stack>
  );
}
