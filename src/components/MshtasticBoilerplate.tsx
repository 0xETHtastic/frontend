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
import { MeshDevice, Types } from "@meshtastic/core";
import { TransportWebSerial } from "@meshtastic/transport-web-serial";
import { Channel as ChannelProto } from "@meshtastic/protobufs";
import { create } from "@bufbuild/protobuf";
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

interface ActionRecord {
  action: string;
  field: SendToEvvmField | Record<string, any>;
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
            setActionQueue((prev) => {
              const next = [...prev, record];
              return next;
            });
            // Send to API if online
            if (navigator.onLine) {
              fetch("/api/sendToEvvm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(record.field),
              })
                .then((res) => res.json())
                .then((data) => {
                  console.log("[API] sendToEvvm response:", data);
                })
                .catch((err) => {
                  console.error("[API] sendToEvvm request failed:", err);
                });
            } else {
              console.warn("[API] Offline — sendToEvvm not sent, stored locally only");
            }
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
  // Render
  // ============================================

  return (
    <div style={{ padding: "20px" }}>
      <h1>Meshtastic Serial Boilerplate</h1>

      {/* Connection Section */}
      <div style={{ marginBottom: "20px" }}>
        <h2>Connection</h2>
        <p>Status: {isConnected ? "Connected" : "Disconnected"}</p>
        {!isConnected ? (
          <button onClick={connect}>Connect Serial</button>
        ) : (
          <button onClick={disconnect}>Disconnect</button>
        )}
      </div>

      {/* Primary Channel Configuration */}
      <div style={{ marginBottom: "20px" }}>
        <h2>Primary Channel (0)</h2>
        <div style={{ marginBottom: "10px" }}>
          <label>PSK Size: </label>
          <select
            value={primaryPSKSize}
            onChange={(e) => setPrimaryPSKSize(e.target.value as PSKSize)}
          >
            <option value="none">None (No encryption)</option>
            <option value="8bit">8 bits (Simple)</option>
            <option value="128bit">128 bits (AES-128)</option>
            <option value="256bit">256 bits (AES-256)</option>
          </select>
          <button onClick={generatePrimaryPSK}>Generate</button>
        </div>
        <input
          type="text"
          placeholder="Base64 PSK (or generate above)"
          value={primaryPSK}
          onChange={(e) => setPrimaryPSK(e.target.value)}
          style={{ width: "300px" }}
        />
        <button onClick={setupPrimaryPSK} disabled={!isConnected}>
          Set Primary PSK
        </button>
      </div>

      {/* Secondary Channel Configuration */}
      <div style={{ marginBottom: "20px" }}>
        <h2>Secondary Channel (1)</h2>
        <div style={{ marginBottom: "10px" }}>
          <label>PSK Size: </label>
          <select
            value={secondaryPSKSize}
            onChange={(e) => setSecondaryPSKSize(e.target.value as PSKSize)}
          >
            <option value="none">None (No encryption)</option>
            <option value="8bit">8 bits (Simple)</option>
            <option value="128bit">128 bits (AES-128)</option>
            <option value="256bit">256 bits (AES-256)</option>
          </select>
          <button onClick={generateSecondaryPSK}>Generate</button>
        </div>
        <input
          type="text"
          placeholder="Base64 PSK (or generate above)"
          value={secondaryPSK}
          onChange={(e) => setSecondaryPSK(e.target.value)}
          style={{ width: "300px" }}
        />
        <button onClick={setupSecondaryPSK} disabled={!isConnected}>
          Set Secondary PSK
        </button>
      </div>

      {/* Send Message Section */}
      <div style={{ marginBottom: "20px" }}>
        <h2>Send Message</h2>
        <select
          value={channel}
          onChange={(e) => setChannel(Number(e.target.value))}
        >
          <option value={0}>Primary (0)</option>
          <option value={1}>Secondary (1)</option>
        </select>
        <input
          type="text"
          placeholder="Message"
          value={messageText}
          onChange={(e) => setMessageText(e.target.value)}
        />
        <button onClick={sendMessage} disabled={!isConnected}>
          Send
        </button>
        <button onClick={sendTestMessage} disabled={!isConnected}>
          Send Test Message
        </button>
      </div>

      <div>
        <h2>EVVM Signature Test</h2>
        <input
          id="toAddressInput_Pay"
          type="text"
          placeholder="To Address"
          style={{ width: "300px", marginBottom: "10px" }}
        />
        <input
          id="amountTokenInput_Pay"
          type="text"
          placeholder="Amount"
          style={{ width: "300px", marginBottom: "10px" }}
        />
        <input
          id="priorityFeeInput_Pay"
          type="text"
          placeholder="Priority Fee (gwei)"
          style={{ width: "300px", marginBottom: "10px" }}
        />
        <input
          id="nonceInput_Pay"
          type="text"
          placeholder="Nonce"
          style={{ width: "300px", marginBottom: "10px" }}
        />
        <button onClick={makeSig}>Create Signature</button>
      </div>

      {/* Action Queue (localStorage) */}
      <div style={{ marginBottom: "20px" }}>
        <h2>Action Queue (localStorage)</h2>
        <button
          onClick={() => {
            setActionQueue([]);
          }}
          style={{ marginBottom: "10px" }}
        >
          Clear Queue
        </button>
        {actionQueue.length === 0 ? (
          <p>No actions stored</p>
        ) : (
          actionQueue.map((record, i) => (
            <div
              key={i}
              style={{
                marginBottom: "10px",
                border: "1px solid #444",
                borderLeft: "4px solid #0070f3",
                padding: "10px",
                borderRadius: "4px",
              }}
            >
              <p>
                <strong>Action:</strong> {record.action}
              </p>
              <p>
                <strong>From:</strong> {record.from}
              </p>
              <p>
                <strong>Channel:</strong> {record.channel}
              </p>
              <p>
                <strong>Time:</strong>{" "}
                {new Date(record.timestamp).toLocaleString()}
              </p>
              <details>
                <summary>Field data ({Object.keys(record.field).length} fields)</summary>
                <pre
                  style={{
                    background: "#f5f5f5",
                    padding: "8px",
                    borderRadius: "4px",
                    overflow: "auto",
                    fontSize: "12px",
                  }}
                >
                  {JSON.stringify(record.field, null, 2)}
                </pre>
              </details>
              <button
                style={{ marginTop: "8px" }}
                onClick={() => {
                  fetch("/api/sendToEvvm", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(record.field),
                  })
                    .then((res) => res.json())
                    .then((data) => {
                      console.log("[API] Manual submit response:", data);
                      alert("Submitted! Check console for response.");
                    })
                    .catch((err) => {
                      console.error("[API] Manual submit failed:", err);
                      alert("Submit failed. Check console for details.");
                    });
                }}
              >
                Submit to API
              </button>
            </div>
          ))
        )}
      </div>

      {/* Messages Display Section */}
      <div>
        <h2>Messages</h2>
        {messages.length === 0 ? (
          <p>No messages</p>
        ) : (
          messages.map((msg, i) => (
            <div
              key={i}
              style={{
                marginBottom: "10px",
                border: "1px solid black",
                padding: "10px",
              }}
            >
              <p>Channel: {msg.channel}</p>
              <p>From: {msg.from}</p>
              <p>Text: {msg.text}</p>
              <p>Time: {new Date(msg.timestamp).toLocaleString()}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
