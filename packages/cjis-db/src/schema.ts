/**
 * Kysely table types for schema `cjis` (the enclave database). Generated
 * columns are `Generated<…>`; encrypted CJI columns end in `_enc` and hold
 * the AES-GCM blob from @cg/crypto under the agency key (SEC-10).
 */
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;

export interface AgencyTable {
  id: Generated<string>;
  name: string;
  agency_identifier: string;
  platform_county: string | null;
  status: Generated<'active' | 'suspended'>;
  exercise: Generated<boolean>;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface DataDictionaryTable {
  table_name: string;
  column_name: string;
  classification: string;
  retention_category: string;
  description: string | null;
}

export interface CjisDatabase {
  'cjis.agency': AgencyTable;
  'cjis.data_dictionary': DataDictionaryTable;
}
