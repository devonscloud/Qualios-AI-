/**
 * @qualios/industry-packs — the industry-pack mechanism (B-110).
 *
 * The shared core is industry-neutral. Everything industry-specific lives
 * in a pack: a pack contributes, without any core code change,
 *   - taxonomy values (product categories),
 *   - listing / distribution-record types,
 *   - tax bases it registers with the generic tax engine,
 *   - lot dispositions (pack-defined end-states such as destruction),
 *   - import file header aliases (pack-specific source-file formats),
 *   - product attribute keys (pack-scoped attributes, e.g. THC for
 *     cannabis — the core must not know what THC is),
 *   - the external source systems it imports from.
 *
 * A pack is configuration + extension-table data, not a fork: the core
 * tables (products, lots, movements, reconciliations, ledger) never gain
 * an industry-specific column. Packs are enabled per tenant
 * (organization_packs, migration 0011); pack surfaces in the API are
 * gated on the tenant's enabled packs (apps/api/src/lib/packs.ts).
 *
 * Status meanings: ACTIVE = the pack's contributions are complete enough
 * to use; IN_PROGRESS = contributions exist but the pack is not yet
 * validated for sale; STUB = descriptor only, no contributions yet.
 * No pack may be marketed as compliance-ready without a jurisdictional
 * gap assessment and domain-expert review (blueprint §6).
 */

export interface PackTaxonomyValue {
  /** Stable key stored as products.category_key. */
  key: string;
  label: string;
  parentKey?: string;
}

export interface PackListingType {
  /** Stable key stored as distributor_listings.listing_type. */
  key: string;
  label: string;
  description: string;
}

export interface PackTaxBase {
  /** Stable key stored as tax_rules.basis. */
  key: string;
  label: string;
  /** Unit the rate is charged per (e.g. "mg", "unit", "litre", "kg"). */
  unit: string;
}

export interface PackLotDisposition {
  /** Stable key stored as lot_dispositions.disposition_key. */
  key: string;
  label: string;
  /** True when the disposition ends the lot's usable life. */
  terminal: boolean;
}

export interface PackProductAttributeKey {
  /** Stable key stored as product_attributes.attribute_key. */
  key: string;
  label: string;
  valueType: "text" | "integer" | "numeric";
}

export interface PackSourceSystem {
  /** Stable key stored as import_runs.external_source. */
  key: string;
  label: string;
}

export interface IndustryPack {
  id: string;
  name: string;
  country: string;
  status: "STUB" | "IN_PROGRESS" | "ACTIVE" | "VALIDATED";
  description: string;
  taxonomy: PackTaxonomyValue[];
  listingTypes: PackListingType[];
  taxBases: PackTaxBase[];
  lotDispositions: PackLotDisposition[];
  /** Normalized file header -> canonical import field (see lib/imports.ts). */
  importHeaderAliases: Record<string, string>;
  productAttributeKeys: PackProductAttributeKey[];
  sourceSystems: PackSourceSystem[];
}

export const CANNABIS_PACK: IndustryPack = {
  country: "CA",
  description:
    "Canadian cannabis: cultivation/processing lots, packaging, QA release, test records, inventory movements, seed-to-sale reconciliation, excise, and region-specific distributor listings. Validated on the Herba Farms pilot before sale.",
  id: "cannabis-ca",
  importHeaderAliases: {
    // A seed-to-sale export names the product column "Strain". That is a
    // cannabis file-format fact, so the alias lives in this pack, not in
    // the core's generic header map.
    strain: "product_name",
  },
  listingTypes: [
    {
      description: "Saskatchewan distributor allocation record.",
      key: "SK_ALLOCATION",
      label: "Saskatchewan allocation",
    },
    {
      description: "Saskatchewan new-product listing form.",
      key: "SK_LISTING",
      label: "Saskatchewan listing",
    },
    {
      description: "Manitoba distributor allocation record.",
      key: "MB_ALLOCATION",
      label: "Manitoba allocation",
    },
    {
      description: "Manitoba Liquor & Lotteries product listing application form.",
      key: "MBLL_PLAF",
      label: "MBLL product listing application",
    },
  ],
  lotDispositions: [
    {
      key: "AWAITING_DESTRUCTION",
      label: "Awaiting destruction",
      terminal: false,
    },
    {
      key: "DESTROYED",
      label: "Destroyed",
      terminal: true,
    },
  ],
  name: "Cannabis (Canada)",
  productAttributeKeys: [
    { key: "strain_type", label: "Strain type", valueType: "text" },
    { key: "thc_label_mg", label: "THC, label (mg)", valueType: "integer" },
    { key: "thc_label_mg_per_g", label: "THC, label (mg/g)", valueType: "integer" },
    { key: "thc_tested_mg_per_g", label: "THC, tested (mg/g)", valueType: "integer" },
  ],
  sourceSystems: [{ key: "SEED_TO_SALE", label: "Seed-to-sale system export" }],
  status: "IN_PROGRESS",
  taxBases: [
    {
      key: "PER_MG_THC",
      label: "Per milligram of THC",
      unit: "mg THC",
    },
  ],
  taxonomy: [
    { key: "DRIED_FLOWER", label: "Dried flower" },
    { key: "PRE_ROLL", label: "Pre-roll" },
    { key: "INFUSED_PRE_ROLL", label: "Infused pre-roll" },
    { key: "EXTRACT", label: "Extract" },
    { key: "VAPE_CART", label: "Vape cartridge" },
    { key: "EDIBLE", label: "Edible" },
    { key: "OTHER", label: "Other" },
  ],
};

export const FOOD_PACK: IndustryPack = {
  country: "CA",
  description:
    "Food and beverage: farm-to-table traceability, HACCP records, allergen attributes, temperature and recall handling. Demo pack for the second synthetic tenant.",
  id: "food-ca",
  importHeaderAliases: {},
  listingTypes: [
    {
      description: "Retail buyer listing record.",
      key: "RETAILER_LISTING",
      label: "Retailer listing",
    },
    {
      description: "Distributor allocation record.",
      key: "DISTRIBUTOR_ALLOCATION",
      label: "Distributor allocation",
    },
    {
      description: "Foodservice buyer listing record.",
      key: "FOODSERVICE_LISTING",
      label: "Foodservice listing",
    },
  ],
  lotDispositions: [
    {
      key: "CONDEMNED",
      label: "Condemned (food safety)",
      terminal: true,
    },
    {
      key: "DISPOSED",
      label: "Disposed",
      terminal: true,
    },
  ],
  name: "Food & Beverage (Canada)",
  productAttributeKeys: [
    { key: "allergens", label: "Allergens", valueType: "text" },
    { key: "best_before_days", label: "Best-before shelf life (days)", valueType: "integer" },
    { key: "storage_temperature_c", label: "Storage temperature (°C)", valueType: "numeric" },
  ],
  sourceSystems: [{ key: "SUPPLIER_PORTAL", label: "Supplier portal export" }],
  status: "IN_PROGRESS",
  taxBases: [
    { key: "PER_UNIT", label: "Per unit", unit: "unit" },
    { key: "PER_KG", label: "Per kilogram", unit: "kg" },
    { key: "AD_VALOREM", label: "Percentage of value", unit: "value" },
  ],
  taxonomy: [
    { key: "FRESH_PRODUCE", label: "Fresh produce" },
    { key: "DAIRY", label: "Dairy" },
    { key: "MEAT", label: "Meat" },
    { key: "BAKERY", label: "Bakery" },
    { key: "BEVERAGE", label: "Beverage" },
    { key: "PACKAGED_GOODS", label: "Packaged goods" },
    { key: "SOUP", label: "Soup" },
    { key: "OTHER", label: "Other" },
  ],
};

export const INDUSTRIAL_PACK: IndustryPack = {
  country: "GLOBAL",
  description:
    "Industrial fabrication and manufacturing: raw material to finished assembly, material certificates, inspection/test plans, and job costing. Descriptor with core contributions; workflows land with the Phase 4 build.",
  id: "industrial-generic",
  importHeaderAliases: {},
  listingTypes: [
    {
      description: "Distributor listing record.",
      key: "DISTRIBUTOR_LISTING",
      label: "Distributor listing",
    },
    {
      description: "Customer quotation listing record.",
      key: "CUSTOMER_QUOTE_LISTING",
      label: "Customer quote listing",
    },
  ],
  lotDispositions: [{ key: "SCRAPPED", label: "Scrapped", terminal: true }],
  name: "Industrial Manufacturing",
  productAttributeKeys: [
    { key: "material_grade", label: "Material grade", valueType: "text" },
    { key: "material_certificate", label: "Material certificate number", valueType: "text" },
  ],
  sourceSystems: [{ key: "ERP_EXPORT", label: "ERP export" }],
  status: "STUB",
  taxBases: [
    { key: "PER_UNIT", label: "Per unit", unit: "unit" },
    { key: "AD_VALOREM", label: "Percentage of value", unit: "value" },
    { key: "PER_LITRE", label: "Per litre", unit: "litre" },
  ],
  taxonomy: [
    { key: "RAW_MATERIAL", label: "Raw material" },
    { key: "COMPONENT", label: "Component" },
    { key: "ASSEMBLY", label: "Assembly" },
    { key: "FINISHED_GOOD", label: "Finished good" },
    { key: "CONSUMABLE", label: "Consumable" },
    { key: "OTHER", label: "Other" },
  ],
};

export const INDUSTRY_PACKS: IndustryPack[] = [CANNABIS_PACK, FOOD_PACK, INDUSTRIAL_PACK];

/** Core import kinds. Industry specifics are source systems, not kinds. */
export const CORE_IMPORT_KINDS = ["EXTERNAL_SNAPSHOT", "PAPER_COUNT", "ALLOCATION"] as const;
export type CoreImportKind = (typeof CORE_IMPORT_KINDS)[number];

/** Tax bases the generic core engine knows without any pack. */
export const CORE_TAX_BASES = ["PER_UNIT", "AD_VALOREM", "PER_LITRE", "PER_KG"] as const;

export function getPack(packId: string): IndustryPack | undefined {
  return INDUSTRY_PACKS.find((pack) => pack.id === packId);
}

/** Tax bases registered by one pack (empty when the pack id is unknown). */
export function taxBasesForPack(packId: string): PackTaxBase[] {
  return getPack(packId)?.taxBases ?? [];
}

/** Source systems registered by one pack. */
export function sourceSystemsForPack(packId: string): PackSourceSystem[] {
  return getPack(packId)?.sourceSystems ?? [];
}

/**
 * Merge the import header aliases contributed by the given packs.
 * The first pack to claim a normalized header wins; core aliases always
 * win over pack aliases (the caller merges core first).
 */
export function importHeaderAliasesForPacks(packIds: string[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const packId of packIds) {
    const pack = getPack(packId);
    if (!pack) continue;
    for (const [header, canonical] of Object.entries(pack.importHeaderAliases)) {
      if (!(header in merged)) merged[header] = canonical;
    }
  }
  return merged;
}

/** Taxonomy values contributed by one pack. */
export function taxonomyForPack(packId: string): PackTaxonomyValue[] {
  return getPack(packId)?.taxonomy ?? [];
}

/** Listing types contributed by one pack. */
export function listingTypesForPack(packId: string): PackListingType[] {
  return getPack(packId)?.listingTypes ?? [];
}

/** Lot dispositions contributed by one pack. */
export function lotDispositionsForPack(packId: string): PackLotDisposition[] {
  return getPack(packId)?.lotDispositions ?? [];
}
