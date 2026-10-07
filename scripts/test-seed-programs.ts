import assert from "node:assert/strict";
import fs from "node:fs";
import { ensureFirstAdmin } from "../src/seedAdmin";
import { ensureMissingPrograms, type SeedProgramInput } from "../src/seedPrograms";

const MISSING_CODE = "SEED_PROTECT_MISSING";
const EXISTING_CODE = "BILIRKISI_DESKTOP";

function assertLocalUrl(url: string): string {
  if (/railway|rlwy\.net|lisans-server-backend-production/i.test(url)) {
    throw new Error("Canlı veritabanı reddedildi");
  }
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error("Yerel olmayan veritabanı reddedildi");
  }
  return url;
}

function localDatabaseUrl(): string {
  const override = process.env.SEED_TEST_DATABASE_URL?.trim();
  if (override) return assertLocalUrl(override);
  const file = "C:/Users/Woontegra/Desktop/Woontegra-Lisans-Server/.env";
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^DATABASE_URL=(.*)$/m);
  if (!match) throw new Error("Yerel DATABASE_URL bulunamadı");
  return assertLocalUrl(match[1].trim().replace(/^['"]|['"]$/g, ""));
}

async function memoryCheck() {
  type Row = SeedProgramInput & { id: string };
  const rows = new Map<string, Row>();
  rows.set("BILIRKISI_DESKTOP", {
    id: "program-1",
    appCode: "BILIRKISI_DESKTOP",
    name: "Panel adı",
    description: "Panel açıklaması",
    productType: "DESKTOP",
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 180,
    defaultMaxDevices: 4,
  });

  const defaults: SeedProgramInput[] = [
    {
      appCode: "BILIRKISI_DESKTOP",
      name: "Seed adı",
      description: "Seed açıklaması",
      productType: "DESKTOP",
      targetService: "seed-service",
      saasProductCode: "seed-code",
      defaultLicenseDays: 365,
      defaultMaxDevices: 1,
    },
    {
      appCode: MISSING_CODE,
      name: "Eksik program",
      description: "Yeni kayıt",
      productType: "DESKTOP",
      targetService: null,
      saasProductCode: null,
      defaultLicenseDays: 30,
      defaultMaxDevices: 2,
    },
  ];

  const run = () =>
    ensureMissingPrograms({
      defaults,
      findByAppCode: async (appCode) => rows.get(appCode) ?? null,
      create: async (data) => {
        const row = { ...data, id: `created-${rows.size + 1}` };
        rows.set(data.appCode, row);
        return row;
      },
    });

  const first = await run();
  const second = await run();
  const kept = rows.get("BILIRKISI_DESKTOP");
  assert.equal(kept?.id, "program-1");
  assert.equal(kept?.description, "Panel açıklaması");
  assert.equal(kept?.defaultMaxDevices, 4);
  assert.equal(kept?.defaultLicenseDays, 180);
  assert.equal(kept?.name, "Panel adı");
  assert.deepEqual(first.createdAppCodes, [MISSING_CODE]);
  assert.deepEqual(second.createdAppCodes, []);
  assert.equal([...rows.keys()].filter((code) => code === "BILIRKISI_DESKTOP").length, 1);
  assert.equal([...rows.keys()].filter((code) => code === MISSING_CODE).length, 1);
}

async function databaseCheck() {
  process.env.DATABASE_URL = localDatabaseUrl();
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  let snapshot: {
    id: string;
    appCode: string;
    name: string;
    description: string | null;
    productType: "DESKTOP" | "SAAS";
    targetService: string | null;
    saasProductCode: string | null;
    defaultLicenseDays: number;
    defaultMaxDevices: number;
    isActive: boolean;
  } | null = null;
  let createdAdmin = false;
  let createdProgram = false;
  const database = new URL(process.env.DATABASE_URL ?? "postgres://127.0.0.1/unknown");

  try {
    let adminBefore = await prisma.admin.findFirst({ orderBy: { createdAt: "asc" } });
    if (!adminBefore) {
      adminBefore = await prisma.admin.create({
        data: {
          email: "seed-protect-test@local.test",
          passwordHash: "hash:mevcut-parola",
          name: "Seed Koruma",
        },
      });
      createdAdmin = true;
    }
    const adminCountBefore = await prisma.admin.count();
    const adminHash = adminBefore.passwordHash;

    const adminGuard = await ensureFirstAdmin({
      existing: adminBefore,
      email: "baska@woontegra.com",
      password: "railway-yeni-parola",
      hashPassword: async () => "degismis-hash",
      create: async () => {
        throw new Error("mevcut yönetici yeniden oluşturulmamalı");
      },
    });
    assert.equal(adminGuard.created, false);
    assert.equal(adminGuard.admin.passwordHash, adminHash);

    snapshot = await prisma.program.findUnique({ where: { appCode: EXISTING_CODE } });
    if (!snapshot) {
      snapshot = await prisma.program.create({
        data: {
          appCode: EXISTING_CODE,
          name: "Bilirkişi Hesap",
          description: "Önceki panel açıklaması",
          productType: "DESKTOP",
          defaultLicenseDays: 365,
          defaultMaxDevices: 1,
          isActive: true,
        },
      });
      createdProgram = true;
    }
    const original = snapshot;

    const editedDescription = "SEED-KORUMA-TEST-ACIKLAMA";
    const editedMaxDevices = original.defaultMaxDevices === 7 ? 8 : 7;
    await prisma.program.update({
      where: { id: original.id },
      data: { description: editedDescription, defaultMaxDevices: editedMaxDevices },
    });

    const seedDefault: SeedProgramInput = {
      appCode: EXISTING_CODE,
      name: "Seed bunu yazmamalı",
      description: "Seed açıklaması yazılmamalı",
      productType: "SAAS",
      targetService: "seed-hedef",
      saasProductCode: "seed-urun",
      defaultLicenseDays: original.defaultLicenseDays === 11 ? 12 : 11,
      defaultMaxDevices: 1,
    };
    const missingDefault: SeedProgramInput = {
      appCode: MISSING_CODE,
      name: "Eksik program",
      description: "Yeni kayıt",
      productType: "DESKTOP",
      targetService: null,
      saasProductCode: null,
      defaultLicenseDays: 30,
      defaultMaxDevices: 2,
    };

    const beforeCount = await prisma.program.count({ where: { appCode: EXISTING_CODE } });
    const first = await ensureMissingPrograms({
      defaults: [seedDefault, missingDefault],
      findByAppCode: (appCode) => prisma.program.findUnique({ where: { appCode } }),
      create: (data) => prisma.program.create({ data }),
    });
    const second = await ensureMissingPrograms({
      defaults: [seedDefault, missingDefault],
      findByAppCode: (appCode) => prisma.program.findUnique({ where: { appCode } }),
      create: (data) => prisma.program.create({ data }),
    });

    const kept = await prisma.program.findUnique({ where: { appCode: EXISTING_CODE } });
    assert.ok(kept);
    assert.equal(kept.id, original.id);
    assert.equal(kept.appCode, original.appCode);
    assert.equal(kept.name, original.name);
    assert.equal(kept.description, editedDescription);
    assert.equal(kept.productType, original.productType);
    assert.equal(kept.defaultLicenseDays, original.defaultLicenseDays);
    assert.equal(kept.defaultMaxDevices, editedMaxDevices);
    assert.equal(kept.targetService, original.targetService);
    assert.equal(kept.saasProductCode, original.saasProductCode);
    assert.equal(kept.isActive, original.isActive);
    assert.equal(beforeCount, 1);
    assert.equal(await prisma.program.count({ where: { appCode: EXISTING_CODE } }), 1);
    assert.deepEqual(first.createdAppCodes, [MISSING_CODE]);
    assert.deepEqual(second.createdAppCodes, []);
    assert.equal(await prisma.program.count({ where: { appCode: MISSING_CODE } }), 1);

    const adminAfter = await prisma.admin.findFirst({ orderBy: { createdAt: "asc" } });
    assert.equal(adminAfter?.passwordHash, adminHash);
    assert.equal(await prisma.admin.count(), adminCountBefore);

    console.log(
      JSON.stringify({
        database: `${database.hostname}${database.pathname}`,
        keptAppCode: EXISTING_CODE,
        keptId: kept.id,
        description: kept.description,
        defaultMaxDevices: kept.defaultMaxDevices,
        missingCreated: first.createdAppCodes,
        secondRunCreated: second.createdAppCodes,
        duplicateCount: 1,
        adminHashUnchanged: true,
      }),
    );
  } finally {
    if (snapshot && createdProgram) {
      await prisma.program.delete({ where: { id: snapshot.id } });
    } else if (snapshot) {
      await prisma.program.update({
        where: { id: snapshot.id },
        data: {
          name: snapshot.name,
          description: snapshot.description,
          productType: snapshot.productType,
          targetService: snapshot.targetService,
          saasProductCode: snapshot.saasProductCode,
          defaultLicenseDays: snapshot.defaultLicenseDays,
          defaultMaxDevices: snapshot.defaultMaxDevices,
          isActive: snapshot.isActive,
        },
      });
    }
    await prisma.program.deleteMany({ where: { appCode: MISSING_CODE } });
    if (createdAdmin) {
      await prisma.admin.deleteMany({ where: { email: "seed-protect-test@local.test" } });
    }
    await prisma.$disconnect();
  }
}

async function main() {
  await memoryCheck();
  console.log("seed program memory check passed");
  await databaseCheck();
  console.log("seed program database check passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "test failed");
  process.exit(1);
});
