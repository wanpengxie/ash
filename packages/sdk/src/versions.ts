/** Every version and protocol name in one place. Nothing else in the repository spells these strings. */

/** Message format (`Message`, `SendRequest`, the response body). */
export const API_VERSION = "ash-api/3";
/** Word contract generation: the fields of `WordContract` in word.ts. */
export const WORD_CONTRACT_VERSION = 4;
/** `ASH_SDK` in the docs: the SDK generation. Moves together with the word contract. */
export const ASH_SDK = 4;
/** The one connection protocol between the kernel and every hand (packages/link). */
export const LINK_PROTOCOL = "ash-link/2";
/** The computer program (packages/device) this hub pairs: its release on GitHub (`device-v<version>`) is what the install command fetches. */
export const DEVICE_VERSION = "0.2.4";
/** Where its releases are published (`<this>/device-v<version>/<asset>`). */
export const DEVICE_RELEASES = "https://github.com/wanpengxie/ash/releases/download";
/** The kernel host contract (host.json, host interface, host events). */
export const HOST_CONTRACT = "ash-host/1";
/** The app contract (app.json, the app bridge). */
export const APP_CONTRACT = "ash-app/1";
/** The agent tool surface: the MCP server every agent connects to. */
export const MCP_SERVER_NAME = "ash";
export const MCP_SERVER_VERSION = "4.0.0";
