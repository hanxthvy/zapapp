// [xihanzu-NR]
'use strict';

/**
 * Android Host <-> Embedded Node.js IPC Bridge Module for ZapApp.
 *
 * Provides bidirectional communication, line framing, serialization, and deserialization
 * between the Android Java host (NodeRunner.java / libnode) and the embedded Node.js engine.
 *
 * Transports supported:
 * - Localhost TCP loopback server (line-delimited JSON stream)
 * - Android Janea Systems rn-bridge channel
 * - Node process IPC (process.send / process.on('message'))
 * - Stdio stream (process.stdin / process.stdout)
 * - Android Logcat line-delimited event broadcast ([BRIDGE_EVENT])
 */

// ponytail: line-delimited JSON over loopback TCP/stdio; upgrade to unix domain sockets or shared memory ring buffer if multi-megabyte binary streaming needed.

const EventEmitter = require('events');
const net = require('net');
const readline = require('readline');

const DEFAULT_IPC_PORT = 28789;
const DEFAULT_IPC_HOST = '127.0.0.1';

// -----------------------------------------------------------------------------
// 1. Serialization Helpers
// -----------------------------------------------------------------------------

/**
 * Safely converts any JavaScript value into a JSON string.
 * Handles Buffers, BigInt, Errors, and circular references cleanly.
 */
function safeStringify(value, space) {
  const seen = new WeakSet();

  return JSON.stringify(
    value,
    function (key, val) {
      const raw = this ? this[key] : undefined;
      if (raw && Buffer.isBuffer(raw)) {
        return { type: 'Buffer', data: raw.toString('base64'), encoding: 'base64' };
      }
      if (val && val.type === 'Buffer' && Array.isArray(val.data)) {
        return { type: 'Buffer', data: Buffer.from(val.data).toString('base64'), encoding: 'base64' };
      }
      if (typeof val === 'bigint') {
        return val.toString();
      }
      if (val instanceof Error) {
        return {
          name: val.name,
          message: val.message,
          stack: val.stack,
          code: val.code || val.errno
        };
      }
      if (val !== null && typeof val === 'object') {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    },
    space
  );
}

/**
 * Serializes an outbound event into standard Android Bridge event schema:
 * { event: string, data: object, timestamp: number }
 * Supports string event name or { event, ...data } object input.
 */
function serializeEvent(event, data, timestamp) {
  let eventName = event;
  let eventData = data;

  if (event && typeof event === 'object') {
    eventName = event.event || 'unknown_event';
    eventData = (data !== undefined && data !== null) ? data : event;
  } else if (!event || typeof event !== 'string') {
    throw new TypeError('Event name must be a non-empty string');
  }

  const normalizedData = (eventData !== null && typeof eventData === 'object')
    ? eventData
    : (eventData !== undefined ? { value: eventData } : {});

  return {
    event: String(eventName),
    data: normalizedData,
    timestamp: typeof timestamp === 'number' ? timestamp : Date.now()
  };
}

/**
 * Serializes an RPC command response:
 * { reqId: string|null, status: 'ok'|'error', result?: any, error?: string }
 */
function serializeResponse(reqId, result, error) {
  const isError = Boolean(error);
  const payload = {
    reqId: reqId !== undefined && reqId !== null ? String(reqId) : null,
    status: isError ? 'error' : 'ok'
  };

  if (isError) {
    payload.error = error instanceof Error
      ? error.message
      : (typeof error === 'string' ? error : safeStringify(error));
  } else {
    payload.result = result !== undefined ? result : null;
  }

  return payload;
}

/**
 * Serializes an outbound RPC command:
 * { command: string, args: object, reqId: string|null }
 */
function serializeCommand(command, args, reqId) {
  if (!command || typeof command !== 'string') {
    throw new TypeError('Command name must be a non-empty string');
  }

  return {
    command,
    args: (args !== null && typeof args === 'object') ? args : {},
    reqId: reqId !== undefined && reqId !== null ? String(reqId) : null
  };
}

/**
 * Encodes a payload object into a newline-terminated UTF-8 JSON line.
 */
function formatLine(payload) {
  return safeStringify(payload) + '\n';
}

// -----------------------------------------------------------------------------
// 2. Deserialization & Normalization Helpers
// -----------------------------------------------------------------------------

/**
 * Custom error thrown when incoming IPC data fails to parse.
 */
class IpcParseError extends Error {
  constructor(message, rawInput) {
    super(message);
    this.name = 'IpcParseError';
    this.rawInput = rawInput;
  }
}

/**
 * Safely parses raw text or Buffer into a JavaScript object.
 */
function deserialize(input) {
  if (input === null || input === undefined) {
    throw new IpcParseError('Cannot deserialize null or undefined input', input);
  }

  let text;
  if (typeof input === 'string') {
    text = input;
  } else if (Buffer.isBuffer(input)) {
    text = input.toString('utf8');
  } else if (typeof input === 'object') {
    return input; // Already parsed
  } else {
    text = String(input);
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new IpcParseError('Cannot deserialize empty input string', input);
  }

  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new IpcParseError(`Failed to parse IPC JSON: ${err.message}`, text);
  }
}

/**
 * Normalizes an arbitrary parsed object into a standardized message descriptor:
 * - 'command': { type: 'command', command, args, reqId, raw }
 * - 'response': { type: 'response', reqId, status, result, error, raw }
 * - 'event':    { type: 'event', event, data, timestamp, raw }
 * - 'raw':      { type: 'raw', payload: msg }
 */
function normalizeMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return { type: 'raw', payload: msg };
  }

  // 1. Inbound RPC response from remote
  if (msg.reqId !== undefined && (msg.status !== undefined || msg.result !== undefined || msg.error !== undefined)) {
    return {
      type: 'response',
      reqId: String(msg.reqId),
      status: msg.status || (msg.error ? 'error' : 'ok'),
      result: msg.result !== undefined ? msg.result : null,
      error: msg.error || null,
      raw: msg
    };
  }

  // 2. Inbound command from Android host
  const cmd = msg.command || msg.action || msg.type || msg.cmd;
  if (cmd && typeof cmd === 'string' && !msg.event) {
    const args = msg.args !== undefined ? msg.args : (msg.payload !== undefined ? msg.payload : (msg.data !== undefined ? msg.data : {}));
    const reqId = msg.reqId !== undefined ? String(msg.reqId) : (msg.id !== undefined ? String(msg.id) : null);
    return {
      type: 'command',
      command: cmd,
      args: (args !== null && typeof args === 'object') ? args : { value: args },
      reqId,
      raw: msg
    };
  }

  // 3. Inbound event pushed by host
  const event = msg.event || msg.eventName;
  if (event && typeof event === 'string') {
    const data = msg.data !== undefined ? msg.data : (msg.payload !== undefined ? msg.payload : msg);
    return {
      type: 'event',
      event,
      data: (data !== null && typeof data === 'object') ? data : { value: data },
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
      raw: msg
    };
  }

  return { type: 'raw', payload: msg };
}

/**
 * Parses and normalizes a single line string.
 */
function parseLine(line) {
  const parsed = deserialize(line);
  return normalizeMessage(parsed);
}

/**
 * Streaming line-delimited decoder for chunked streams (e.g., net.Socket, streams).
 * Handles partial chunks, multi-line chunks, carriage returns, and invalid JSON lines gracefully.
 */
function createLineDecoder(onMessage, onError) {
  let buffer = '';

  return {
    push(chunk) {
      if (chunk === null || chunk === undefined) return;
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (line.endsWith('\r')) {
          line = line.slice(0, -1);
        }
        line = line.trim();
        if (!line) continue;

        try {
          const parsed = deserialize(line);
          const normalized = normalizeMessage(parsed);
          if (typeof onMessage === 'function') {
            onMessage(normalized, line);
          }
        } catch (err) {
          if (typeof onError === 'function') {
            onError(err, line);
          }
        }
      }
    },
    reset() {
      buffer = '';
    },
    getPending() {
      return buffer;
    }
  };
}

// -----------------------------------------------------------------------------
// 3. IpcBridge Class
// -----------------------------------------------------------------------------

class IpcBridge extends EventEmitter {
  constructor(options = {}) {
    super();

    this._explicitPort = Boolean(options.port);
    this.port = parseInt(options.port || process.env.NODEJS_IPC_PORT || process.env.IPC_PORT || DEFAULT_IPC_PORT, 10);
    this.host = options.host || DEFAULT_IPC_HOST;
    this.logger = options.logger || console;

    this.enableTcp = options.enableTcp !== false;
    this.enableStdio = options.enableStdio !== false;
    this.enableProcessIpc = options.enableProcessIpc !== false;
    this.enableRnBridge = options.enableRnBridge !== false;

    this.tcpServer = null;
    this.tcpClients = new Set();
    this.commandHandlers = new Map();
    this.pendingRequests = new Map();
    this.reqCounter = 1;
    this.readlineInterface = null;
    this.rnBridge = null;
    this.running = false;

    // Register built-in diagnostic commands
    this.registerCommand('ping', async () => ({ pong: true, timestamp: Date.now() }));
    this.registerCommand('status', async () => ({
      status: 'active',
      uptime: process.uptime(),
      clients: this.tcpClients.size,
      port: this.port
    }));
  }

  /**
   * Registers an async command handler. Normalizes command key.
   */
  registerCommand(command, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`Handler for command '${command}' must be a function`);
    }
    const norm = String(command || '').toLowerCase().replace(/-/g, '_');
    this.commandHandlers.set(norm, handler);
    this.commandHandlers.set(command, handler);
    return this;
  }

  /**
   * Alias for registerCommand.
   */
  onCommand(command, handler) {
    return this.registerCommand(command, handler);
  }

  /**
   * Unregisters a command handler.
   */
  unregisterCommand(command) {
    const norm = String(command || '').toLowerCase().replace(/-/g, '_');
    this.commandHandlers.delete(norm);
    this.commandHandlers.delete(command);
    return this;
  }

  /**
   * Dispatches a command to registered handlers.
   */
  async dispatchCommand(command, args = {}) {
    const norm = String(command || '').toLowerCase().replace(/-/g, '_');
    const handler = this.commandHandlers.get(norm) || this.commandHandlers.get(command);
    if (!handler) {
      throw new Error(`Unknown command '${command}'`);
    }
    return await handler(args);
  }

  /**
   * Starts all configured IPC transports.
   */
  async start() {
    if (this.running) return this;

    // Refresh dynamic environment port if not explicitly configured in constructor
    if (!this._explicitPort && (process.env.NODEJS_IPC_PORT || process.env.IPC_PORT)) {
      this.port = parseInt(process.env.NODEJS_IPC_PORT || process.env.IPC_PORT, 10);
    }

    this.running = true;

    // 1. Janea Systems rn-bridge integration
    if (this.enableRnBridge) {
      this._setupRnBridge();
    }

    // 2. Node process IPC (if spawned via child_process.fork)
    if (this.enableProcessIpc && typeof process.send === 'function') {
      this._setupProcessIpc();
    }

    // 3. Stdio line reader
    if (this.enableStdio && process.stdin && !process.stdin.destroyed) {
      this._setupStdio();
    }

    // 4. Localhost TCP Server
    if (this.enableTcp) {
      await this._setupTcpServer();
    }

    return this;
  }

  /**
   * Stops all active transports and closes connections.
   */
  async stop() {
    this.running = false;

    // Close readline
    if (this.readlineInterface) {
      try {
        this.readlineInterface.close();
      } catch (_) {}
      this.readlineInterface = null;
    }

    // Close TCP clients
    for (const client of this.tcpClients) {
      try {
        client.destroy();
      } catch (_) {}
    }
    this.tcpClients.clear();

    // Close TCP server
    if (this.tcpServer) {
      await new Promise((resolve) => {
        this.tcpServer.close(() => resolve());
      });
      this.tcpServer = null;
    }

    // Reject pending requests
    for (const [reqId, { reject, timer }] of this.pendingRequests.entries()) {
      clearTimeout(timer);
      reject(new Error(`IPC Bridge stopped while waiting for response to ${reqId}`));
    }
    this.pendingRequests.clear();

    return this;
  }

  /**
   * Emits and broadcasts an event to Android host across all active transports.
   */
  sendEvent(event, data) {
    const payload = serializeEvent(event, data);
    const jsonStr = safeStringify(payload);
    const line = jsonStr + '\n';

    // 1. Janea Systems rn-bridge
    if (this.rnBridge && this.rnBridge.channel) {
      try {
        if (typeof this.rnBridge.channel.post === 'function') {
          this.rnBridge.channel.post(payload.event, payload.data);
        }
        if (typeof this.rnBridge.channel.send === 'function') {
          this.rnBridge.channel.send(jsonStr);
        }
      } catch (err) {
        this.logger.warn(`[IPC:rn-bridge] Event dispatch error (${payload.event}):`, err.message);
      }
    }

    // 2. Process IPC
    if (typeof process.send === 'function') {
      try {
        process.send(payload);
      } catch (_) {}
    }

    // 3. Local in-process EventEmitter
    this.emit(payload.event, payload.data);
    this.emit('ipc_event', payload);

    // 4. Connected TCP IPC clients
    for (const clientSocket of this.tcpClients) {
      try {
        if (!clientSocket.destroyed) {
          clientSocket.write(line);
        }
      } catch (_) {
        this.tcpClients.delete(clientSocket);
      }
    }

    // 5. Line-delimited stdout log for Android Logcat log capture
    this.logger.log(`[BRIDGE_EVENT] ${jsonStr}`);

    return payload;
  }

  /**
   * Convenience alias matching general bridge.send(event, data) or bridge.send(payload).
   */
  send(eventOrPayload, data) {
    if (eventOrPayload && typeof eventOrPayload === 'object' && eventOrPayload.event && data === undefined) {
      return this.sendEvent(eventOrPayload.event, eventOrPayload);
    }
    return this.sendEvent(eventOrPayload, data);
  }

  /**
   * Convenience alias matching bridge.post(event, data).
   */
  post(event, data) {
    return this.sendEvent(event, data);
  }

  /**
   * Sends an RPC response over a specific transport or client socket.
   */
  sendResponse(target, reqId, result, error) {
    const payload = serializeResponse(reqId, result, error);
    const line = formatLine(payload);

    if (target && typeof target.write === 'function' && !target.destroyed) {
      try {
        target.write(line);
      } catch (err) {
        this.logger.warn('[IPC] Failed to write response to target socket:', err.message);
      }
    } else if (target === 'rn-bridge' && this.rnBridge && this.rnBridge.channel) {
      try {
        this.rnBridge.channel.send(safeStringify(payload));
      } catch (_) {}
    } else if (target === 'process' && typeof process.send === 'function') {
      try {
        process.send(payload);
      } catch (_) {}
    } else {
      // Broadcast response to all TCP clients
      for (const client of this.tcpClients) {
        try {
          if (!client.destroyed) client.write(line);
        } catch (_) {}
      }
    }

    return payload;
  }

  /**
   * Sends an outbound RPC command from Node to Android host and awaits response.
   */
  async sendCommand(command, args = {}, timeoutMs = 15000) {
    const reqId = `node_req_${this.reqCounter++}`;
    const payload = serializeCommand(command, args, reqId);
    const line = formatLine(payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`Timeout waiting for response to command '${command}' (reqId: ${reqId})`));
      }, timeoutMs);

      this.pendingRequests.set(reqId, { resolve, reject, timer });

      let sent = false;
      for (const client of this.tcpClients) {
        try {
          if (!client.destroyed) {
            client.write(line);
            sent = true;
          }
        } catch (_) {}
      }

      if (!sent && this.rnBridge && this.rnBridge.channel) {
        try {
          this.rnBridge.channel.send(safeStringify(payload));
          sent = true;
        } catch (_) {}
      }

      if (!sent && typeof process.send === 'function') {
        try {
          process.send(payload);
          sent = true;
        } catch (_) {}
      }

      if (!sent) {
        clearTimeout(timer);
        this.pendingRequests.delete(reqId);
        reject(new Error(`No active IPC transport available to send command '${command}'`));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Internal Transport Setups & Inbound Processing
  // ---------------------------------------------------------------------------

  async _handleInboundMessage(normalized, transportTarget) {
    if (!normalized) return;

    if (normalized.type === 'response') {
      const pending = this.pendingRequests.get(normalized.reqId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(normalized.reqId);
        if (normalized.status === 'ok') {
          pending.resolve(normalized.result);
        } else {
          pending.reject(new Error(normalized.error || 'IPC Command failed'));
        }
      }
      return;
    }

    if (normalized.type === 'command') {
      const { command, args, reqId } = normalized;
      try {
        const result = await this.dispatchCommand(command, args);
        if (reqId) {
          this.sendResponse(transportTarget, reqId, result, null);
        }
      } catch (err) {
        if (reqId) {
          this.sendResponse(transportTarget, reqId, null, err);
        } else {
          this.logger.warn(`[IPC] Command '${command}' unhandled error:`, err.message);
        }
      }
      return;
    }

    if (normalized.type === 'event') {
      this.emit(normalized.event, normalized.data);
      this.emit('ipc_event', normalized);
      return;
    }

    if (normalized.type === 'raw') {
      this.emit('raw_message', normalized.payload);
    }
  }

  _setupRnBridge() {
    try {
      this.rnBridge = require('rn-bridge');
      if (this.rnBridge && this.rnBridge.channel) {
        this.rnBridge.channel.on('message', async (msg) => {
          try {
            const parsed = deserialize(msg);
            const normalized = normalizeMessage(parsed);
            await this._handleInboundMessage(normalized, 'rn-bridge');
          } catch (err) {
            this.logger.error('[IPC:rn-bridge] Inbound message error:', err.message);
          }
        });

        // Attach direct command event names if dispatched as channel events
        const knownCommands = ['send_message', 'send_button_message', 'request_pairing_code', 'disconnect'];
        knownCommands.forEach((cmd) => {
          this.rnBridge.channel.on(cmd, async (args) => {
            try {
              await this.dispatchCommand(cmd, args);
            } catch (err) {
              this.logger.error(`[IPC:rn-bridge] Direct event '${cmd}' error:`, err.message);
            }
          });
        });
        this.logger.log('[IPC] Attached rn-bridge channel listeners.');
      }
    } catch (_) {}
  }

  _setupProcessIpc() {
    process.on('message', async (msg) => {
      if (!msg) return;
      try {
        const normalized = normalizeMessage(msg);
        await this._handleInboundMessage(normalized, 'process');
      } catch (err) {
        this.logger.error('[IPC:process] Process message handling error:', err.message);
      }
    });
    this.logger.log('[IPC] Attached process IPC message listener.');
  }

  _setupStdio() {
    try {
      this.readlineInterface = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });

      this.readlineInterface.on('line', async (line) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) return;
        try {
          const parsed = deserialize(trimmed);
          const normalized = normalizeMessage(parsed);
          await this._handleInboundMessage(normalized, null);
        } catch (err) {
          this.logger.warn('[IPC:stdio] Line processing error:', err.message);
        }
      });
    } catch (_) {}
  }

  _setupTcpServer() {
    return new Promise((resolve) => {
      try {
        this.tcpServer = net.createServer((socket) => {
          this.tcpClients.add(socket);

          const decoder = createLineDecoder(
            async (normalized) => {
              await this._handleInboundMessage(normalized, socket);
            },
            (err, rawLine) => {
              this.logger.warn('[IPC:tcp] Line framing parse error:', err.message);
              socket.write(formatLine({ status: 'error', error: err.message }));
            }
          );

          socket.on('data', (chunk) => decoder.push(chunk));
          socket.on('close', () => this.tcpClients.delete(socket));
          socket.on('error', () => this.tcpClients.delete(socket));
        });

        this.tcpServer.listen(this.port, this.host, () => {
          this.logger.log(`[NodeRunner] TCP IPC bridge listening on ${this.host}:${this.port}`);
          resolve();
        });

        this.tcpServer.on('error', (err) => {
          this.logger.log(`[NodeRunner] TCP IPC bridge disabled (${err.message})`);
          resolve();
        });
      } catch (err) {
        this.logger.warn('[IPC:tcp] Server initialization error:', err.message);
        resolve();
      }
    });
  }
}

/**
 * Factory helper function to create and configure an IpcBridge instance.
 */
function createIpcBridge(options = {}) {
  return new IpcBridge(options);
}

module.exports = {
  IpcBridge,
  createIpcBridge,
  serializeEvent,
  serializeResponse,
  serializeCommand,
  safeStringify,
  deserialize,
  safeParse: deserialize,
  normalizeMessage,
  formatLine,
  parseLine,
  createLineDecoder,
  IpcParseError,
  DEFAULT_IPC_PORT,
  DEFAULT_IPC_HOST
};
