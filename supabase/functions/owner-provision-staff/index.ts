// ============================================================================
// MASAR Care — Stage 2B.2A.3 Edge Function: owner-provision-staff (NOT DEPLOYED)
// Browser-callable owner-only pharmacy staff provisioning strictly scoped to
// caller's pharmacy_id.
// Gateway auth & CORS notes:
// - Set `verify_jwt = false` in `supabase/config.toml` so anonymous browser
//   OPTIONS preflight reaches this handler AND modern Supabase Auth JWTs are
//   verified live inside the handler via `adminClient.auth.getUser(jwt)` plus
//   authoritative `pharmacy_staff` (`is_active = true`, `role = 'pharmacy_owner'`).
// - Enforces explicit `MASAR_CORS_ALLOWED_ORIGINS` allowlist (never `*`).
// - Runtime CORS through the Supabase Edge gateway remains UNVERIFIED until deployment.
// ============================================================================
// @ts-expect-error Deno npm specifier resolved at Supabase Edge Runtime
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  type AdminSupabaseLike,
  handleOwnerProvisionStaffHttpRequest,
} from '../_shared/adminProvisioningLogic.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

Deno.serve(async (req: Request) => {
  const allowedOrigins = Deno.env.get('MASAR_CORS_ALLOWED_ORIGINS') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  const adminClient =
    supabaseUrl && serviceRoleKey
      ? (createClient(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        }) as unknown as AdminSupabaseLike)
      : null;

  return handleOwnerProvisionStaffHttpRequest({
    req,
    adminClient,
    allowedOrigins,
    requireAllowlist: true,
  });
});
