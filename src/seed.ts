import { PrismaClient, ProgramProductType } from '@prisma/client';
import { ensureFirstAdmin } from './seedAdmin';
import { ensureMissingPrograms } from './seedPrograms';
import { hashPassword } from './utils/password';
import { KOOPPLUS_PROGRAM_DEFAULTS } from './constants/desktopTrial';
import {
  APP_CODE_AKTUERYA_DESKTOP,
  APP_CODE_AKTUERYA_SAAS,
  SAAS_PRODUCT_CODE_AKTUERYA,
  SAAS_TARGET_AKTUERYA,
} from './constants/aktuerya';

const prisma = new PrismaClient();

const DEFAULT_PROGRAMS: Array<{
  appCode: string;
  name: string;
  description: string;
  productType: ProgramProductType;
  targetService: string | null;
  saasProductCode: string | null;
  defaultLicenseDays: number;
  defaultMaxDevices: number;
}> = [
  {
    appCode: 'MUVEKKIL_KASA_DESKTOP',
    name: 'Müvekkil Kasa Defteri Desktop',
    description: 'Müvekkil kasa defteri masaüstü uygulaması',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'SIFRE_KASASI_DESKTOP',
    name: 'Şifre Kasası Desktop',
    description: 'Şifre kasası masaüstü uygulaması',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'ISLETME_DEFTERI_DESKTOP',
    name: 'İşletme Defteri Desktop',
    description: 'İşletme defteri masaüstü uygulaması',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'OPTIK_DESKTOP',
    name: 'Optik Programı Desktop',
    description: 'Optik programı masaüstü uygulaması',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: 'BILIRKISI_DESKTOP',
    name: 'Bilirkişi Desktop',
    description: 'Bilirkişi masaüstü uygulaması',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: KOOPPLUS_PROGRAM_DEFAULTS.appCode,
    name: KOOPPLUS_PROGRAM_DEFAULTS.name,
    description: KOOPPLUS_PROGRAM_DEFAULTS.description,
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: KOOPPLUS_PROGRAM_DEFAULTS.defaultLicenseDays,
    defaultMaxDevices: KOOPPLUS_PROGRAM_DEFAULTS.defaultMaxDevices,
  },
  {
    appCode: APP_CODE_AKTUERYA_DESKTOP,
    name: 'Aktüerya Hesaplama Desktop',
    description: 'Aktüerya hesaplama masaüstü uygulaması. Windows ve macOS aynı program kodunu kullanır.',
    productType: ProgramProductType.DESKTOP,
    targetService: null,
    saasProductCode: null,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
  {
    appCode: APP_CODE_AKTUERYA_SAAS,
    name: 'Aktüerya Hesaplama SaaS',
    description: 'Aktüerya hesaplama web aboneliği. Provision henüz bağlı değildir.',
    productType: ProgramProductType.SAAS,
    targetService: SAAS_TARGET_AKTUERYA,
    saasProductCode: SAAS_PRODUCT_CODE_AKTUERYA,
    defaultLicenseDays: 365,
    defaultMaxDevices: 1,
  },
];

async function main() {
  const existingAdmin = await prisma.admin.findFirst({ orderBy: { createdAt: 'asc' } });
  const adminResult = await ensureFirstAdmin({
    existing: existingAdmin,
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    hashPassword,
    create: (data) => prisma.admin.create({ data }),
  });
  if (adminResult.created) {
    console.log(`Admin kullanıcı oluşturuldu: ${adminResult.admin.email}`);
  } else {
    console.log(`Mevcut yönetici korunuyor: ${adminResult.admin.email}`);
  }

  const programResult = await ensureMissingPrograms({
    defaults: DEFAULT_PROGRAMS,
    findByAppCode: (appCode) => prisma.program.findUnique({ where: { appCode } }),
    create: (data) => prisma.program.create({ data }),
  });
  for (const appCode of programResult.createdAppCodes) {
    console.log(`Program oluşturuldu: ${appCode}`);
  }

  console.log('Seed tamamlandı.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
