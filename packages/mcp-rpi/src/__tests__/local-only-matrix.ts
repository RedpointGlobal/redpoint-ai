/**
 * The local-only rule's matrix: which Origin and Host values pass (used by
 * local-only.test.ts). Allowed: what native clients and local pages send (measured: no
 * Origin from Claude Code, mcp-remote, the MCP SDK, curl; .NET's expanded IPv6
 * loopback Host). Refused: everything else, "null", malformed values and a
 * DNS-rebinding Host included.
 */
export const ORIGINS: Array<[string | undefined, boolean]> = [
  [undefined, true], // native clients
  ["http://localhost:6274", true], // MCP Inspector's UI, direct mode
  ["http://127.0.0.1:6274", true],
  ["http://[::1]:6274", true],
  ["http://localhost", true],
  ["https://localhost:8443", true],
  ["HTTP://LOCALHOST:6274", true],
  ["null", false], // a sandboxed iframe, a file:// page
  ["", false],
  ["garbage", false],
  ["http://", false],
  ["http://evil.example", false],
  ["https://evil.example:3002", false],
  ["http://localhost.evil.example", false],
  ["http://127.0.0.1.nip.io", false],
  ["http://127.0.0.2:6274", false],
  ["http://0.0.0.0:6274", false],
  ["http://localhost:6274/", false], // not an Origin serialization
  ["http://localhost:6274/path", false],
  ["http://user@localhost:6274", false],
  ["ws://localhost:6274", false],
  ["file://", false],
  ["chrome-extension://abcdefghijklmnop", false],
];

export const HOSTS: Array<[string | undefined, boolean]> = [
  ["localhost:3002", true],
  ["127.0.0.1:3002", true],
  ["[::1]:3002", true],
  ["localhost", true],
  ["LOCALHOST:3002", true],
  ["[0000:0000:0000:0000:0000:0000:0000:0001]:3002", true], // .NET's IPv6 loopback (measured)
  ["[0:0:0:0:0:0:0:1]:3002", true],
  ["[::2]:3002", false],
  ["[::ffff:192.168.1.5]:3002", false],
  [undefined, false],
  ["", false],
  ["evil.example:3002", false], // DNS rebinding
  ["evil.example", false],
  ["localhost.evil.example:3002", false],
  ["192.168.1.5:3002", false],
  ["0.0.0.0:3002", false],
  ["127.0.0.2:3002", false],
  ["user@localhost:3002", false],
  ["localhost:3002/x", false],
  ["localhost:abc", false],
];
