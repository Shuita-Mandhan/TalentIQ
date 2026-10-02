import { createClient } from "@/lib/supabase/server";

// Read helpers for the control plane. Every query runs as the signed-in user under RLS, which only
// exposes these rows in full to platform admins.

export type PlatformOrganization = {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: string;
};

export type PlatformService = {
  key: string;
  name: string;
  description: string | null;
  is_active: boolean;
};

export type ServiceEntitlement = { service_key: string; enabled: boolean };

/** One row per organization: its lifecycle state and how it is administered. */
export type PlatformOrganizationOverview = {
  organization_id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: string;
  has_recovery_manager: boolean;
  administrator_count: number;
  pending_admin_email: string | null;
  pending_admin_invitation_id: string | null;
  pending_admin_since: string | null;
  pending_member_invitations: number;
  caller_is_member: boolean;
};

/**
 * The whole control plane in one read. Returns null rather than throwing when the overview
 * function is unreachable: the operations dashboard is more useful degraded, saying plainly that
 * administration state could not be loaded, than replaced by an error page that also takes down
 * everything else on it.
 */
export async function getPlatformOverview(): Promise<PlatformOrganizationOverview[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_platform_organizations_overview");
  if (error) {
    console.error("get_platform_organizations_overview failed:", error);
    return null;
  }
  return data as PlatformOrganizationOverview[];
}

const ORGANIZATION_COLUMNS = "id, name, slug, is_active, created_at";

export async function getPlatformOrganizations(limit?: number): Promise<PlatformOrganization[]> {
  const supabase = await createClient();
  let query = supabase
    .from("organizations")
    .select(ORGANIZATION_COLUMNS)
    .order("created_at", { ascending: false });
  if (limit) query = query.limit(limit);
  const { data, error } = await query;
  if (error) throw new Error("Unable to load organizations");
  return data;
}

export async function getPlatformOrganization(id: string): Promise<PlatformOrganization | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select(ORGANIZATION_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("Unable to load the organization");
  return data;
}

export async function getPlatformStats() {
  const supabase = await createClient();
  const count = (table: string, filter?: { is_active: boolean }) => {
    let query = supabase.from(table).select("*", { count: "exact", head: true });
    if (filter) query = query.eq("is_active", filter.is_active);
    return query;
  };
  const [organizations, active, services] = await Promise.all([
    count("organizations"),
    count("organizations", { is_active: true }),
    count("platform_services"),
  ]);
  if (organizations.error || active.error || services.error) {
    throw new Error("Unable to load platform statistics");
  }
  return {
    organizations: organizations.count ?? 0,
    active: active.count ?? 0,
    suspended: (organizations.count ?? 0) - (active.count ?? 0),
    services: services.count ?? 0,
  };
}

export async function getPlatformServices(): Promise<PlatformService[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("platform_services")
    .select("key, name, description, is_active")
    .order("name");
  if (error) throw new Error("Unable to load platform services");
  return data;
}

export async function getOrganizationServiceEntitlements(
  organizationId: string,
): Promise<ServiceEntitlement[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organization_service_entitlements")
    .select("service_key, enabled")
    .eq("organization_id", organizationId);
  if (error) throw new Error("Unable to load service entitlements");
  return data;
}
