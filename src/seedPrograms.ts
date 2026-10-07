export type SeedProgramInput = {
  appCode: string;
  name: string;
  description: string | null;
  productType: "DESKTOP" | "SAAS";
  targetService: string | null;
  saasProductCode: string | null;
  defaultLicenseDays: number;
  defaultMaxDevices: number;
};

/** Veritabanında olmayan program kodlarını ekler. Var olan satırın hiçbir alanını değiştirmez. */
export async function ensureMissingPrograms<T extends { id: string; appCode: string }>(input: {
  defaults: SeedProgramInput[];
  findByAppCode: (appCode: string) => Promise<T | null>;
  create: (data: SeedProgramInput) => Promise<T>;
}): Promise<{ createdAppCodes: string[] }> {
  const createdAppCodes: string[] = [];
  for (const program of input.defaults) {
    const existing = await input.findByAppCode(program.appCode);
    if (existing) continue;
    await input.create(program);
    createdAppCodes.push(program.appCode);
  }
  return { createdAppCodes };
}
