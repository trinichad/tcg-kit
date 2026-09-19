// Origin: BinderPricer server/core/psa.ts @ e995c9e.
// Changed: the PSA_API_TOKEN env read becomes `config.tokens.psa`; module-level
// cache/fetch become `ctx` (factory `createPsa`). Quota/auth/notfound
// classification and the never-cache-a-failure rule are untouched.
//
// PSA public cert-verification API (account token; daily call quotas are
// TIGHT — observed "maximum admitted 1 per Day" on the entry tier, 2026-07-08).
// Docs: https://www.psacard.com/publicapi — GET /cert/GetByCertNumber/{cert}
// with an "Authorization: bearer <token>" header. Certs are immutable, so
// results cache long and callers should reuse a verification everywhere
// rather than looking the same cert up twice.

import type { PricingCtx } from '../context';
import type { PsaLookupError, PsaVerify } from '../types';

const DAY = 24 * 3600_000;

export interface PsaLookup {
  psa: PsaVerify | null;
  error?: PsaLookupError;
}

const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';

export type Psa = ReturnType<typeof createPsa>;

export function createPsa(ctx: PricingCtx) {
  /** Uncached lookup with the failure reason. Never throws. */
  async function psaFetchCertDetailed(cert: string, token: string): Promise<PsaLookup> {
    const clean = cert.replace(/\D/g, '');
    if (!token) return { psa: null, error: 'auth' };
    if (clean.length < 7 || clean.length > 10) return { psa: null, error: 'notfound' };
    try {
      const r = await ctx.fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${clean}`, {
        headers: { authorization: `bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        console.error(`[psa] ${r.status} for cert ${clean}: ${text.slice(0, 120)}`);
        // Quota exhaustion is a 429 whose body says so ("API calls quota
        // exceeded! maximum admitted N per Day") — the token itself is FINE.
        // Plain 429/401/403 without that text is an invalid/rejected token.
        if (/quota\s*exceeded/i.test(text)) return { psa: null, error: 'quota' };
        if (r.status === 401 || r.status === 403 || r.status === 429) {
          return { psa: null, error: 'auth' };
        }
        return { psa: null, error: 'error' };
      }
      const body = (await r.json()) as Record<string, unknown>;
      // Errors can also come back as 200 with flags; data sits under PSACert.
      if (body.IsValidRequest === false) return { psa: null, error: 'notfound' };
      const c = (body.PSACert ?? body) as Record<string, unknown>;
      const subject = str(c.Subject);
      if (!subject) return { psa: null, error: 'notfound' };
      const gradeRaw = str(c.CardGrade);
      const gradeNum = gradeRaw.match(/\d{1,2}(\.5)?/)?.[0] ?? '';
      return {
        psa: {
          cert: str(c.CertNumber) || clean,
          grade: gradeNum,
          gradeDescription: str(c.GradeDescription) || gradeRaw,
          year: str(c.Year),
          brand: str(c.Brand),
          subject,
          cardNumber: str(c.CardNumber),
          variety: str(c.Variety),
          url: `https://www.psacard.com/cert/${clean}`,
        },
      };
    } catch (err) {
      console.error(`[psa] cert lookup failed for ${clean}:`, err);
      return { psa: null, error: 'error' };
    }
  }

  /** Back-compat plain lookup (used by a settings token test). */
  async function psaFetchCert(cert: string, token: string): Promise<PsaVerify | null> {
    return (await psaFetchCertDetailed(cert, token)).psa;
  }

  /**
   * Cached cert lookup with failure reason. The token comes from the caller
   * (their own, wins) or `config.tokens.psa`. Successes cache 30 days (certs
   * are immutable); failures are never cached, so tomorrow's quota can fix
   * today's miss. Returns {psa:null} without error when no token is set —
   * callers then keep the label read silently.
   */
  async function psaCertDetailed(cert: string, tokenOverride?: string): Promise<PsaLookup> {
    const token = (tokenOverride ?? '').trim() || (ctx.tokens.psa ?? '').trim();
    if (!token) return { psa: null };
    const clean = cert.replace(/\D/g, '');
    if (clean.length < 7 || clean.length > 10) return { psa: null, error: 'notfound' };
    let error: PsaLookupError | undefined;
    const psa = await ctx.cached(`psa:${clean}`, 30 * DAY, async () => {
      const r = await psaFetchCertDetailed(clean, token);
      error = r.error;
      return r.psa; // null on failure → not cached (see cache.ts)
    });
    return psa ? { psa } : { psa: null, error: error ?? 'error' };
  }

  /** Back-compat cached lookup returning just the record. */
  async function psaCert(cert: string, tokenOverride?: string): Promise<PsaVerify | null> {
    return (await psaCertDetailed(cert, tokenOverride)).psa;
  }

  const hasToken = (override?: string): boolean =>
    Boolean((override ?? '').trim() || (ctx.tokens.psa ?? '').trim());

  return { psaFetchCert, psaFetchCertDetailed, psaCert, psaCertDetailed, hasToken };
}
