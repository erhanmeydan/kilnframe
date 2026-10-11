// Trust the certificates the operating system trusts, as well as Node's own list. Antivirus programs and
// company networks on Windows open HTTPS with their own root certificate, which Windows trusts and Node does
// not: the speech model download then failed with "fetch failed" (SELF_SIGNED_CERT_IN_CHAIN, 11 Oct 2026),
// while the same address opened in the browser. Imported first by the companion and every job process.
import tls from "node:tls";

export function useSystemCertificates(): void {
  try {
    const all = new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")]);
    tls.setDefaultCACertificates([...all]);
    // Node programs these processes start (HyperFrames) read the same setting from the environment
    process.env.NODE_USE_SYSTEM_CA = "1";
  } catch {
    // an older Node without these calls keeps its own list
  }
}

useSystemCertificates();
