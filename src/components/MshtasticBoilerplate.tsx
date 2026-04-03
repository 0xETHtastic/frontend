'use client'

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
import util from 'util';

if (!util.formatWithOptions) {
  util.formatWithOptions = function(inspectOptions, format, ...args) {
    return util.format ? util.format(format, ...args) : format;
  };
}

import { useState } from 'react'
import { MeshDevice, Types } from '@meshtastic/core'
import { TransportWebSerial } from '@meshtastic/transport-web-serial'
import { Channel as ChannelProto } from '@meshtastic/protobufs'
import { create } from '@bufbuild/protobuf'

/**
 * Available PSK (Pre-Shared Key) size options for channel encryption.
 * - `none`: No encryption (0 bytes) 
 * - `8bit`: Simple encryption (1 byte) - minimal security
 * - `128bit`: AES-128 encryption (16 bytes)
 * - `256bit`: AES-256 encryption (32 bytes) - recommended
 */
type PSKSize = 'none' | '8bit' | '128bit' | '256bit'

/**
 * Represents a received message from the mesh network.
 */
interface MeshMessage {
  /** Channel index the message was received on */
  channel: number
  /** Node ID of the sender */
  from: number | string
  /** Text content of the message */
  text: string
  /** Unix timestamp when the message was received */
  timestamp: number
  /** Source event that captured the message (optional) */
  source?: string
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
    case 'none':
      return new Uint8Array(0)
    case '8bit':
      return crypto.getRandomValues(new Uint8Array(1))
    case '128bit':
      return crypto.getRandomValues(new Uint8Array(16))
    case '256bit':
      return crypto.getRandomValues(new Uint8Array(32))
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
  let binary = ''
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i])
  }
  return btoa(binary)
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
  const [device, setDevice] = useState<MeshDevice | null>(null)
  
  /** Current connection status */
  const [isConnected, setIsConnected] = useState(false)
  
  /** Array of received messages */
  const [messages, setMessages] = useState<MeshMessage[]>([])
  
  /** Primary channel PSK in Base64 format */
  const [primaryPSK, setPrimaryPSK] = useState('')
  
  /** Selected PSK size for primary channel */
  const [primaryPSKSize, setPrimaryPSKSize] = useState<PSKSize>('256bit')
  
  /** Secondary channel PSK in Base64 format */
  const [secondaryPSK, setSecondaryPSK] = useState('')
  
  /** Selected PSK size for secondary channel */
  const [secondaryPSKSize, setSecondaryPSKSize] = useState<PSKSize>('256bit')
  
  /** Text message to send */
  const [messageText, setMessageText] = useState('')
  
  /** Selected channel index for sending messages (0 = Primary, 1 = Secondary) */
  const [channel, setChannel] = useState(0)

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
      const transport = await TransportWebSerial.create()
      const meshDevice = new MeshDevice(transport)

      // Track device status and trigger configure handshake
      meshDevice.events.onDeviceStatus.subscribe((status) => {
        console.warn('[Mesh] Status:', Types.DeviceStatusEnum[status], `(${status})`)
        if (status === Types.DeviceStatusEnum.DeviceConnected) {
          meshDevice.configure().then(() => {
            console.warn('[Mesh] configure() ack received')
          }).catch((err) => {
            console.error('[Mesh] configure() failed:', err)
          })
        }
        if (status === Types.DeviceStatusEnum.DeviceConfigured) {
          console.warn('[Mesh] Device fully configured — starting heartbeat')
          meshDevice.setHeartbeatInterval(300_000) // 5 min keepalive
          setIsConnected(true)
        }
        if (status === Types.DeviceStatusEnum.DeviceDisconnected) {
          setIsConnected(false)
        }
      })

      // Monitor ALL FromRadio frames (config, packets, etc.)
      meshDevice.events.onFromRadio.subscribe((fromRadio) => {
        console.warn('[Mesh] FromRadio:', fromRadio.payloadVariant.case)
      })

      // Monitor every MeshPacket: decoded vs encrypted
      meshDevice.events.onMeshPacket.subscribe((meshPacket) => {
        console.warn('[Mesh] MeshPacket:', meshPacket.payloadVariant.case, 'from:', meshPacket.from, 'to:', meshPacket.to)
      })

      // RF activity indicator
      meshDevice.events.onMeshHeartbeat.subscribe((date) => {
        console.warn('[Mesh] RF heartbeat (mesh activity detected):', date.toLocaleTimeString())
      })

      // TEXT_MESSAGE_APP packets — the actual messages
      meshDevice.events.onMessagePacket.subscribe((packet) => {
        console.warn('[Mesh] onMessagePacket:', packet)
        setMessages(prev => [...prev, {
          channel: packet.channel,
          from: packet.from,
          text: packet.data,
          timestamp: Date.now()
        }])
      })

      setDevice(meshDevice)
    } catch (error) {
      console.error('Connection failed:', error)
    }
  }

  /**
   * Disconnects from the currently connected Meshtastic device.
   * Cleans up the device instance and resets connection state.
   */
  function disconnect() {
    if (device) {
      device.disconnect()
      setDevice(null)
      setIsConnected(false)
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
    const psk = generatePSK(primaryPSKSize)
    setPrimaryPSK(uint8ArrayToBase64(psk))
  }

  /**
   * Generates a new PSK for the secondary channel based on the selected size.
   * Updates the secondaryPSK state with the Base64-encoded value.
   */
  function generateSecondaryPSK() {
    const psk = generatePSK(secondaryPSKSize)
    setSecondaryPSK(uint8ArrayToBase64(psk))
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
    if (!device) return

    try {
      let psk: Uint8Array
      
      if (primaryPSK) {
        // Use provided Base64 PSK
        const binaryString = atob(primaryPSK)
        psk = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          psk[i] = binaryString.charCodeAt(i)
        }
      } else {
        // Generate new PSK based on selected size
        psk = generatePSK(primaryPSKSize)
        setPrimaryPSK(uint8ArrayToBase64(psk))
      }
      
      const channelConfig = create(ChannelProto.ChannelSchema, {
        index: 0,
        role: ChannelProto.Channel_Role.PRIMARY,
        settings: {
          psk: psk,
          name: 'Primary'
        }
      })

      await device.setChannel(channelConfig)

      alert('Primary PSK set')
    } catch (error) {
      console.error('Failed to set primary PSK:', error)
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
    if (!device) return

    try {
      let psk: Uint8Array
      
      if (secondaryPSK) {
        // Use provided Base64 PSK
        const binaryString = atob(secondaryPSK)
        psk = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          psk[i] = binaryString.charCodeAt(i)
        }
      } else {
        // Generate new PSK based on selected size
        psk = generatePSK(secondaryPSKSize)
        setSecondaryPSK(uint8ArrayToBase64(psk))
      }

      const channelConfig = create(ChannelProto.ChannelSchema, {
        index: 1,
        role: ChannelProto.Channel_Role.SECONDARY,
        settings: {
          psk: psk,
          name: 'Secondary'
        }
      })

      await device.setChannel(channelConfig)

      alert('Secondary PSK set')
    } catch (error) {
      console.error('Failed to set secondary PSK:', error)
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
    if (!device || !messageText) return

    try {
      await device.sendText(
        messageText,
        undefined, // destination (broadcast)
        true,      // wantAck
        channel    // channel index
      )

      setMessageText('')
      //alert(`Message sent on channel ${channel}`)
    } catch (error) {
      console.error('Failed to send message:', error)
    }
  }

  async function sendTestMessage() {
    if (!device) return

    try {
      await device.sendText(
        'send test by button',
        undefined,
        true,
        channel
      )

      alert(`Test message sent on channel ${channel}`)
    } catch (error) {
      console.error('Failed to send test message:', error)
    }
  }

  // ============================================
  // Render
  // ============================================

  return (
    <div style={{ padding: '20px' }}>
      <h1>Meshtastic Serial Boilerplate</h1>

      {/* Connection Section */}
      <div style={{ marginBottom: '20px' }}>
        <h2>Connection</h2>
        <p>Status: {isConnected ? 'Connected' : 'Disconnected'}</p>
        {!isConnected ? (
          <button onClick={connect}>Connect Serial</button>
        ) : (
          <button onClick={disconnect}>Disconnect</button>
        )}
      </div>

      {/* Primary Channel Configuration */}
      <div style={{ marginBottom: '20px' }}>
        <h2>Primary Channel (0)</h2>
        <div style={{ marginBottom: '10px' }}>
          <label>PSK Size: </label>
          <select value={primaryPSKSize} onChange={(e) => setPrimaryPSKSize(e.target.value as PSKSize)}>
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
          style={{ width: '300px' }}
        />
        <button onClick={setupPrimaryPSK} disabled={!isConnected}>
          Set Primary PSK
        </button>
      </div>

      {/* Secondary Channel Configuration */}
      <div style={{ marginBottom: '20px' }}>
        <h2>Secondary Channel (1)</h2>
        <div style={{ marginBottom: '10px' }}>
          <label>PSK Size: </label>
          <select value={secondaryPSKSize} onChange={(e) => setSecondaryPSKSize(e.target.value as PSKSize)}>
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
          style={{ width: '300px' }}
        />
        <button onClick={setupSecondaryPSK} disabled={!isConnected}>
          Set Secondary PSK
        </button>
      </div>

      {/* Send Message Section */}
      <div style={{ marginBottom: '20px' }}>
        <h2>Send Message</h2>
        <select value={channel} onChange={(e) => setChannel(Number(e.target.value))}>
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

      {/* Messages Display Section */}
      <div>
        <h2>Messages</h2>
        {messages.length === 0 ? (
          <p>No messages</p>
        ) : (
          messages.map((msg, i) => (
            <div key={i} style={{ marginBottom: '10px', border: '1px solid black', padding: '10px' }}>
              <p>Channel: {msg.channel}</p>
              <p>From: {msg.from}</p>
              <p>Text: {msg.text}</p>
              <p>Time: {new Date(msg.timestamp).toLocaleString()}</p>
            </div>
          ))
        )}
      </div>
    </div>
  )
}