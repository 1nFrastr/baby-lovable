/** Browser-safe contracts for administration of a generated app's Supabase. */
export interface SupabaseAuthSettings {
  emailConfirmationRequired: boolean;
  signupEnabled: boolean;
  anonymousSignInsEnabled: boolean;
  siteUrl: string;
  redirectUrls: string[];
}

/** PATCH accepts a flat, nonempty subset of settings. */
export type SupabaseAuthPatch = Partial<SupabaseAuthSettings>;

export interface SupabaseAuthResponse {
  settings: SupabaseAuthSettings;
}

export interface SupabaseColumnReference {
  schema: string;
  table: string;
  column: string;
}

export interface SupabaseColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  references: SupabaseColumnReference | null;
}

export interface SupabaseDatabaseTable {
  schema: string;
  name: string;
  rlsEnabled: boolean;
  columns: SupabaseColumn[];
}

export interface SupabaseSchemaResponse {
  tables: SupabaseDatabaseTable[];
}

export interface SupabaseAuthUser {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  createdAt: string | null;
  lastSignInAt: string | null;
  isAnonymous: boolean;
}

export interface SupabaseUsersRequest {
  offset?: number;
  pageSize?: number;
  search?: string;
}

export interface SupabaseUsersResponse {
  users: SupabaseAuthUser[];
  hasMore: boolean;
  offset: number;
  pageSize: number;
}

export interface SupabaseTableRowsSort {
  column: string;
  direction: "asc" | "desc";
}

export type SupabaseTableRowsFilter = {
  column: string;
  operator: "contains" | "equals" | "not_equals";
  value: string;
} | {
  column: string;
  operator: "is_null" | "is_not_null";
  value?: never;
};

export interface SupabaseTableRowsRequest {
  schema: string;
  table: string;
  offset?: number;
  pageSize?: number;
  sort?: SupabaseTableRowsSort;
  filter?: SupabaseTableRowsFilter;
}

/** Bigint and numeric/decimal fields are strings to preserve database precision. */
export interface SupabaseTableRowsResponse {
  rows: Record<string, unknown>[];
  hasMore: boolean;
  offset: number;
  pageSize: number;
  orderBy: SupabaseTableRowsSort[];
}
