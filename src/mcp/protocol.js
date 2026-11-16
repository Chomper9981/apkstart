'use strict';
/**
 * Minimal MCP (Model Context Protocol) server over stdio — no external dependency.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin / stdout (MCP stdio transport).
 * Implements: initialize, notifications/initialized, ping, tools/list, tools/call.
 * Anything written to stdout that is not a JSON-RPC message breaks the client, so the
 * server redirects console.* to stderr before loading any app module (see server.js).
 */

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

class McpServer {
  /**
   * @param {object} o
   * @param {{name:string, version:string}} o.info
   * @param {string} [o.instructions]
   * @param {Array<{name:string, description:string, inputSchema:object, handler:Function}>} o.tools
   * @param {NodeJS.ReadableStream} [o.input]
   * @param {NodeJS.WritableStream} [o.output]
   */
  constructor({ info, instructions = '', tools, input = process.stdin, output = process.stdout }) {
    this.info = info;
    this.instructions = instructions;
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.input = input;
    this.output = output;
    this._buf = '';
    this._closed = [];
  }

  onClose(cb) { this._closed.push(cb); }

  start() {
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk) => {
      this._buf += chunk;
      let i;
      while ((i = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, i).trim();
        this._buf = this._buf.slice(i + 1);
        if (line) this._handleLine(line);
      }
    });
    this.input.on('end', () => { for (const cb of this._closed) { try { cb(); } catch (_) { /* ignore */ } } });
  }

  _send(msg) {
    this.output.write(`${JSON.stringify(msg)}\n`);
  }

  _reply(id, result) { this._send({ jsonrpc: '2.0', id, result }); }

  _error(id, code, message) { this._send({ jsonrpc: '2.0', id, error: { code, message } }); }

  async _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { this._error(null, -32700, 'Parse error'); return; }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) {
      // eslint-disable-next-line no-await-in-loop
      await this._handle(m);
    }
  }

  async _handle(m) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      if (m && m.id !== undefined && m.method === undefined) return; // a response to us: ignore
      this._error(m && m.id !== undefined ? m.id : null, -32600, 'Invalid Request');
      return;
    }
    const isNotification = m.id === undefined || m.id === null;
    try {
      switch (m.method) {
        case 'initialize': {
          const asked = m.params && m.params.protocolVersion;
          const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
          this._reply(m.id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: this.info,
            instructions: this.instructions,
          });
          return;
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return;
        case 'ping':
          if (!isNotification) this._reply(m.id, {});
          return;
        case 'tools/list':
          this._reply(m.id, {
            tools: [...this.tools.values()].map((t) => ({
              name: t.name, description: t.description, inputSchema: t.inputSchema,
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
          });
          return;
        case 'tools/call': {
          const name = m.params && m.params.name;
          const tool = this.tools.get(name);
          if (!tool) { this._error(m.id, -32602, `Unknown tool: ${name}`); return; }
          let result;
          try {
            result = await tool.handler((m.params && m.params.arguments) || {});
          } catch (e) {
            // Tool failures are results (isError), not protocol errors: the model should see them.
            const code = e && e.code ? ` [${e.code}]` : '';
            result = { content: [{ type: 'text', text: `Error${code}: ${(e && e.message) || e}` }], isError: true };
          }
          this._reply(m.id, normalizeResult(result));
          return;
        }
        default:
          if (!isNotification) this._error(m.id, -32601, `Method not found: ${m.method}`);
      }
    } catch (e) {
      if (!isNotification) this._error(m.id, -32603, String((e && e.message) || e));
    }
  }
}

/** Handlers may return a string, {text}, {image}, or a full {content:[...]} result. */
function normalizeResult(r) {
  if (r == null) return { content: [{ type: 'text', text: 'ok' }] };
  if (typeof r === 'string') return { content: [{ type: 'text', text: r }] };
  if (Array.isArray(r.content)) return r;
  return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
}

module.exports = { McpServer, SUPPORTED_VERSIONS, normalizeResult };
