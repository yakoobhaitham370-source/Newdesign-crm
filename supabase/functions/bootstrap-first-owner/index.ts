// ============================================================================
// MASAR Care — Stage 2B.2A.1 Edge Function: bootstrap-first-owner (NOT DEPLOYED)
// One-time platform-administrator bootstrap for the first pharmacy and owner.
// Requires MASAR_BOOTSTRAP_TOKEN AND dedicated MASAR_PLATFORM_ADMIN_TOKEN.
// ============================================================================
// @ts-expect-error Deno npm specifier resolved at Supabase Edge Runtime
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  type AdminSupabaseLike,
  handleBootstrapFirstOwner,
} from '../_shared/adminProvisioningLogic.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

Deno.serve(async (req: Request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({
        ok: false,
        errorCode: 'SERVER_MISCONFIGURED',
        message: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.',
      }),
      { status: 500, headers: JSON_HEADERS }
    );
  }

  let rawBody: unknown = null;
  if (req.method === 'POST') {
    try {
      rawBody = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, errorCode: 'INVALID_JSON', message: 'Malformed JSON body.' }),
        { status: 400, headers: JSON_HEADERS }
      );
    }
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as AdminSupabaseLike;

  const result = await handleBootstrapFirstOwner({
    method: req.method,
    headers: req.headers,
    rawBody,
    env: {
      bootstrapToken: Deno.env.get('MASAR_BOOTSTRAP_TOKEN'),
      platformAdminToken: Deno.env.get('MASAR_PLATFORM_ADMIN_TOKEN'),
    },
    adminClient,
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: JSON_HEADERS,
  });
});
