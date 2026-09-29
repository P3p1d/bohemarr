import type { License } from '../types.ts';

/**
 * Ported from `drm_engine.novaplus`/`drm_engine.markizavoyo`
 * (`NovaPlusDRMResolver`/`MarkizaVoyoDRMResolver`): both engines POST the
 * Widevine license challenge to the shared AxDRM endpoint, authenticated by
 * an `X-AxDRM-Message` token minted per-media by the CMS and a site-specific
 * `Referer`. No PSSH override or key exchange is required upstream.
 */
export const AXDRM_LICENSE_URL = 'https://drm-widevine-licensing.axprod.net/AcquireLicense';

export function axdrmLicense(token: string, referer: string): License {
  return { url: AXDRM_LICENSE_URL, headers: { Referer: referer, 'X-AxDRM-Message': token } };
}
