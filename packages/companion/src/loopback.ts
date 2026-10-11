/** The companion only ever listens on loopback. */
export const LISTEN_HOST = "127.0.0.1";
/** Also the IPv6 loopback, which Windows tries first for localhost (server.ts). */
export const LISTEN_HOST_V6 = "::1";

/** Returns true only for an explicit IPv4 or IPv6 loopback address. */
export function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
