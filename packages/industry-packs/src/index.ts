/**
 * STUB — @qualios/industry-packs (Days 7–12 scaffold).
 * Industry packs supply terminology, required forms, workflows, validations,
 * regulatory mappings, reports, and integrations on top of the shared core
 * (blueprint §6). The core data model stays shared; packs plug in without a
 * redesign. Only the cannabis pack descriptor exists so far; its workflows
 * and rules land with the wedge build.
 */

export interface IndustryPack {
  id: string;
  name: string;
  country: string;
  status: "STUB" | "IN_PROGRESS" | "VALIDATED";
  description: string;
}

export const CANNABIS_PACK: IndustryPack = {
  country: "CA",
  description:
    "Canadian cannabis: cultivation/processing lots, packaging, QA release, test records, inventory movements, excise, and region-specific reporting. First pack; validated on the Herba Farms pilot before sale.",
  id: "cannabis-ca",
  name: "Cannabis (Canada)",
  status: "STUB",
};

export const INDUSTRY_PACKS: IndustryPack[] = [CANNABIS_PACK];
