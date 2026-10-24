/**
 * The DRH MCP server's own version — ONE source, version.json,
 * inlined at compile. It names the standalone binary zips and the image, is reported
 * as the MCP serverInfo.version and on /health (serverVersion). It is this repo's
 * only version.
 */
import versionData from "../version.json";

export const MCP_DRH_VERSION: string = versionData.version;
